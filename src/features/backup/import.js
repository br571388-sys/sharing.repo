// /import — restore a backup. Reply to a backup .json file with /import.
//
//   1. download + validate (this is the dry run: nothing is changed yet)
//   2. verify the requester is allowed to restore THIS backup scope/group
//   3. show a confirmation with a summary
//   4. on confirm: re-validate, create a safety backup, then restore inside ONE transaction
//   Live data is never touched unless the backup is valid and a safety copy exists.

import { validateBackup } from './validation.js';
import { createValidatedBackup } from './manualBackup.js';
import { fileNameFor, restoreGlobal, restoreGroup } from './snapshot.js';
import { createPending, takePending } from '../../database/state.js';
import { getGroup } from '../../database/groups.js';
import { logBackup } from '../../database/backups.js';
import { Role, isBotOwner, resolveAuthority } from '../../core/permissions.js';
import { btn, markup } from '../../keyboards/inlineKeyboard.js';
import { esc, field, messages } from '../../utils/formatter.js';
import { formatBytes, formatNumber } from '../../utils/helpers.js';
import { formatDateTimeIST } from '../../services/timezone.js';
import { reply, safeEdit } from '../../handlers/helpers.js';
import { TelegramError } from '../../utils/errors.js';
import { backupCaption } from './manualBackup.js';
import { boxHtml } from '../../ui/design.js';

const denied = (text) => ({ ok: false, text: messages.denied(text) });

/** Who may restore this backup, and into which group? */
export async function authorizeImport(ctx, chat, userId, summary) {
  const owner = isBotOwner(ctx.config, userId);
  if (summary.scope === 'global') {
    if (!owner) return denied('Only the bot owner can import a full database backup.');
    if (chat.type !== 'private') return denied('Full backups can only be imported in a private chat with the bot.');
    return { ok: true };
  }

  const inGroup = chat.type === 'group' || chat.type === 'supergroup';
  if (inGroup && Number(chat.id) !== Number(summary.groupChatId)) {
    return denied('This backup belongs to a different group and cannot be imported here.');
  }
  if (!inGroup && !owner) return denied('Group backups must be imported inside the group they belong to.');

  const group = await getGroup(ctx.db, summary.groupChatId);
  if (!group) return { ok: false, text: messages.warning('Group Not Registered', 'The group this backup belongs to is not registered with the bot.') };

  if (owner) return { ok: true, group, restoreAdmins: true };
  const authority = await resolveAuthority(ctx, chat, userId);
  if (!authority.canManage) return denied('Only the group owner or an authorised administrator can import a group backup.');
  return { ok: true, group, restoreAdmins: authority.groupRole === Role.GROUP_OWNER };
}

async function fetchAndValidate(ctx, fileId) {
  const { text, size } = await ctx.tg.downloadText(fileId, ctx.config.backup.maxImportBytes);
  const result = await validateBackup(text);
  return { ...result, size };
}

const errList = (errors) => errors.slice(0, 5).map((e) => `• ${esc(e)}`).join('\n');

export async function importCommand(ctx, msg) {
  const doc = msg.reply_to_message?.document;
  if (!doc) {
    return reply(ctx, msg, messages.usage(['/import (reply to a backup .json file)'], [], 'Send the backup file in this chat, then reply to it with /import.'));
  }
  if (doc.file_size && doc.file_size > ctx.config.backup.maxImportBytes) {
    return reply(ctx, msg, messages.error('File Too Large', `Backup files can be at most ${formatBytes(ctx.config.backup.maxImportBytes)}.`));
  }
  if (!/\.json$/i.test(doc.file_name || '') && doc.mime_type !== 'application/json') {
    return reply(ctx, msg, messages.warning('Not a Backup File', 'Please reply to a backup file made by this bot (.json).'));
  }

  const loading = await reply(ctx, msg, messages.searching('📥', 'Validating the backup...'));
  let checked;
  try {
    checked = await fetchAndValidate(ctx, doc.file_id);
  } catch (e) {
    const tooLarge = e instanceof TelegramError && e.message === 'FILE_TOO_LARGE';
    return safeEdit(ctx, msg.chat.id, loading.message_id, tooLarge ? messages.error('File Too Large', 'This file is larger than the allowed backup size.') : messages.error('Download Failed', 'The file could not be downloaded from Telegram. Please send it again.'));
  }
  if (!checked.ok) {
    return safeEdit(ctx, msg.chat.id, loading.message_id, `${boxHtml("❌", "Invalid Backup")}\n\nThis backup was rejected and nothing was changed:\n${errList(checked.errors)}`);
  }

  const s = checked.summary;
  const authz = await authorizeImport(ctx, msg.chat, msg.from.id, s);
  if (!authz.ok) return safeEdit(ctx, msg.chat.id, loading.message_id, authz.text);

  const id = await createPending(ctx.db, {
    kind: 'import', userId: msg.from.id, chatId: msg.chat.id,
    payload: { fileId: doc.file_id, checksum: s.checksum, scope: s.scope, groupChatId: s.groupChatId }, ttlSec: 600,
  });
  const counts = Object.entries(s.counts).filter(([, n]) => n > 0).map(([t, n]) => `${esc(t)}: ${formatNumber(n)}`).join(' • ') || 'empty';
  const text = [
    '📥 <b>Import Backup</b>', '',
    '✅ Backup validated successfully.', '',
    field('📦', 'Type', s.scope === 'global' ? 'Full Bot Backup' : 'Group Backup'),
    s.scope === 'group' ? field('👥', 'Group', s.groupTitle || s.groupChatId) : null,
    field('🕒', 'Created', formatDateTimeIST(s.createdAtUnix)),
    field('🔖', 'Version', `${s.version} (schema ${s.schemaVersion})`),
    field('🧮', 'Records', counts),
    '',
    s.scope === 'global'
      ? '⚠️ <b>This will REPLACE all current bot data</b> (users, groups, settings). A safety backup is created first.'
      : '⚠️ <b>This will REPLACE this group\'s settings and records.</b> A safety backup is created first.',
    '⏳ Confirm within 10 minutes.',
  ].filter((l) => l !== null).join('\n');
  return safeEdit(ctx, msg.chat.id, loading.message_id, text, { reply_markup: markup([[btn('✅ Confirm Import', `imp:go:${id}`), btn('❌ Cancel', `imp:no:${id}`)]]) });
}

/** Callbacks: imp:go:<id> | imp:no:<id> */
export async function importCallback(ctx, cq, parts) {
  const action = parts[1];
  const { chat, message_id: messageId } = cq.message;

  if (action === 'no') {
    const pending = await takePending(ctx.db, parts[2], 'import');
    if (pending && Number(pending.user_id) !== Number(cq.from.id)) return ctx.tg.answerCallbackQuery(cq.id, 'Only the person who started the import can cancel it.', true);
    await ctx.tg.answerCallbackQuery(cq.id, 'Import cancelled.');
    return safeEdit(ctx, chat.id, messageId, messages.warning('Import Cancelled', 'No data was changed.'));
  }

  const pending = await takePending(ctx.db, parts[2], 'import'); // single use
  if (!pending) {
    await ctx.tg.answerCallbackQuery(cq.id, 'This confirmation expired or was already used.', true);
    return undefined;
  }
  if (Number(pending.user_id) !== Number(cq.from.id) || Number(pending.chat_id) !== Number(chat.id)) {
    await ctx.tg.answerCallbackQuery(cq.id, '🔒 Only the person who started the import can confirm it.', true);
    return undefined;
  }
  await ctx.tg.answerCallbackQuery(cq.id, 'Importing…');
  await safeEdit(ctx, chat.id, messageId, messages.searching('🔄', 'Importing backup...') + '\n\n🛟 Creating a safety backup first.');

  const fail = async (title, detail, error) => {
    await logBackup(ctx.db, { type: 'import', scope: pending.payload.scope, ownerId: cq.from.id, groupChatId: pending.payload.groupChatId, status: 'failed', error });
    await safeEdit(ctx, chat.id, messageId, messages.error(title, detail));
  };

  try {
    // Re-download and re-validate: the file must be exactly what the requester reviewed.
    const checked = await fetchAndValidate(ctx, pending.payload.fileId);
    if (!checked.ok || checked.summary.checksum !== pending.payload.checksum) {
      return await fail('Import Aborted', 'The backup is no longer valid. No data was changed.', 'revalidation failed');
    }
    const authz = await authorizeImport(ctx, chat, cq.from.id, checked.summary);
    if (!authz.ok) { await safeEdit(ctx, chat.id, messageId, authz.text); return undefined; }

    // Safety backup of what is about to be replaced.
    const scope = checked.summary.scope;
    const safety = await createValidatedBackup(ctx, scope, checked.summary.groupChatId);
    if (!safety) return await fail('Import Aborted', 'The target group is not registered. No data was changed.', 'no target group');
    const name = `safety-${fileNameFor(safety.backup, new Date(), ctx.config.botSlug)}`;
    let safe = false;
    if (ctx.storage.configured) {
      try { await ctx.storage.put(`safety/${name}`, safety.bytes); safe = true; } catch { /* try Telegram next */ }
    }
    try {
      await ctx.tg.sendDocument(cq.from.id, safety.bytes, name, { caption: `${boxHtml("🛟", "Safety Backup")}\n\nThis is your data from <i>before</i> the import. Keep it until you are happy with the result.\n\n${backupCaption(safety.backup, safety.bytes.length)}` });
      safe = true;
    } catch { /* covered by R2 above if available */ }
    if (!safe) return await fail('Import Aborted', 'A safety backup could not be stored, so nothing was changed. Open a private chat with the bot (press Start) or configure R2, then try again.', 'safety backup failed');

    // The actual restore: a single transaction. On any error the database is left exactly as it was.
    if (scope === 'global') await restoreGlobal(ctx.db, checked.backup);
    else await restoreGroup(ctx.db, checked.backup, authz.group.id, { restoreAdmins: authz.restoreAdmins });

    await logBackup(ctx.db, { type: 'import', scope, ownerId: cq.from.id, groupChatId: checked.summary.groupChatId, location: 'telegram', sizeBytes: checked.size });
    const total = Object.values(checked.summary.counts).reduce((a, b) => a + b, 0);
    await safeEdit(ctx, chat.id, messageId, [
      '✅ <b>Import Completed</b>', '',
      field('📦', 'Type', scope === 'global' ? 'Full Bot Backup' : 'Group Backup'),
      field('🧮', 'Records restored', formatNumber(total)),
      field('🛟', 'Safety backup', 'sent to your private chat'),
    ].join('\n'));
  } catch (e) {
    await fail('Import Failed', 'The import failed and was rolled back. Your existing data is unchanged.', e?.message);
    throw e;
  }
  return undefined;
}
