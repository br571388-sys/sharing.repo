// /backup — bot owner: full database backup (private chat). Group owner / authorised admin: that group only.
// Group backups are delivered to the requester's PRIVATE chat, never into the group.

import { exportGlobal, exportGroup, fileNameFor, serialize } from './snapshot.js';
import { validateBackup } from './validation.js';
import { logBackup } from '../../database/backups.js';
import { signDownload } from '../../services/storage.js';
import { reply, safeEdit, reactOk } from '../../handlers/helpers.js';
import { esc, field, messages } from '../../utils/formatter.js';
import { formatBytes } from '../../utils/helpers.js';
import { formatDateTimeIST } from '../../services/timezone.js';
import { btn, markup, urlBtn } from '../../keyboards/inlineKeyboard.js';
import { baseUrlFromEnv } from '../../core/urls.js';
import { getBotSetting } from '../../database/settings.js';
import { TelegramError } from '../../utils/errors.js';

const TELEGRAM_FILE_LIMIT = 45 * 1024 * 1024;

export function backupCaption(backup, bytes, { note = '' } = {}) {
  const isGroup = backup.scope === 'group';
  return [
    '💾 <b>Database Backup</b>', '',
    '✅ <b>Backup created successfully!</b>', '',
    field('📦', 'Type', isGroup ? 'Group Backup' : 'Full Bot Backup'),
    isGroup ? field('👥', 'Group', backup.tables.groups[0].title || String(backup.group_chat_id)) : null,
    field('🕒', 'Created', formatDateTimeIST(backup.created_at_unix)),
    field('📁', 'Format', `JSON • v${backup.version} • ${formatBytes(bytes)}`),
    note ? `\n${note}` : null,
  ].filter((l) => l !== null).join('\n');
}

/** Builds + validates a backup. Throws on failure so a broken backup is never reported as successful. */
export async function createValidatedBackup(ctx, scope, groupChatId) {
  const backup = scope === 'global' ? await exportGlobal(ctx.db) : await exportGroup(ctx.db, groupChatId);
  if (!backup) return null;
  const json = serialize(backup);
  const check = await validateBackup(json);
  if (!check.ok) throw new Error(`Backup failed validation: ${check.errors[0]}`);
  return { backup, json, bytes: new TextEncoder().encode(json) };
}

export async function backupCommand(ctx, msg) {
  const inGroup = msg.chat.type !== 'private';
  const scope = inGroup ? 'group' : 'global';
  const loading = await reply(ctx, msg, messages.searching('💾', 'Creating your backup...'));

  let made;
  try {
    made = await createValidatedBackup(ctx, scope, msg.chat.id);
  } catch (e) {
    await logBackup(ctx.db, { type: 'manual', scope, ownerId: msg.from.id, groupChatId: inGroup ? msg.chat.id : null, status: 'failed', error: e.message });
    await safeEdit(ctx, msg.chat.id, loading.message_id, messages.error('Backup Failed', 'The backup could not be created. Nothing was changed. Please try again.'));
    throw e;
  }
  if (!made) return safeEdit(ctx, msg.chat.id, loading.message_id, messages.warning('Group Not Registered', 'This group is not registered yet. Send any command in the group, then try again.'));

  const { backup, bytes } = made;
  const name = fileNameFor(backup, new Date(), ctx.config.botSlug);
  let location = null;
  let link = null;

  if (ctx.storage.configured) {
    try {
      const key = `manual/${scope === 'global' ? 'global' : `group${String(msg.chat.id).replace('-', 'n')}`}/${name}`;
      await ctx.storage.put(key, bytes, { metadata: { scope, created: String(backup.created_at_unix) } });
      location = `r2:${key}`;
      if (bytes.length > TELEGRAM_FILE_LIMIT) {
        const base = baseUrlFromEnv(ctx.config, await getBotSetting(ctx.db, 'public_base_url', ''));
        if (base && ctx.config.setupSecret) link = `${base}/download?t=${await signDownload(ctx.config.setupSecret, key, 900)}`;
      }
    } catch { /* R2 is optional for manual backups; the Telegram copy below still works */ }
  }

  let delivered = false;
  if (bytes.length <= TELEGRAM_FILE_LIMIT) {
    try {
      await ctx.tg.sendDocument(msg.from.id, bytes, name, { caption: backupCaption(backup, bytes.length) });
      delivered = true;
      location = location || 'telegram';
    } catch (e) {
      if (!(e instanceof TelegramError && (e.status === 403 || e.status === 400))) throw e;
      if (inGroup) {
        const info = await ctx.botInfo().catch(() => null);
        await safeEdit(ctx, msg.chat.id, loading.message_id,
          messages.warning('Start the Bot First', 'I could not message you privately. Open a private chat with me, press Start, then run /backup again.'),
          info?.username ? { reply_markup: markup([[urlBtn('💬 Open Private Chat', `https://t.me/${info.username}?start=backup`)]]) } : {});
        return undefined;
      }
      throw e;
    }
  }

  if (!delivered && !link) {
    await logBackup(ctx.db, { type: 'manual', scope, ownerId: msg.from.id, groupChatId: inGroup ? msg.chat.id : null, status: 'failed', sizeBytes: bytes.length, error: 'too large for Telegram and no R2 download available' });
    return safeEdit(ctx, msg.chat.id, loading.message_id, messages.error('Backup Too Large', `The backup is ${formatBytes(bytes.length)}, which is more than Telegram allows. Configure R2 (see README) to get a download link.`));
  }

  await logBackup(ctx.db, { type: 'manual', scope, ownerId: msg.from.id, groupChatId: inGroup ? msg.chat.id : null, location, sizeBytes: bytes.length });
  const text = delivered && inGroup
    ? messages.success('Backup Sent', 'Your group backup was sent to you in a private chat.')
    : link
      ? `${backupCaption(backup, bytes.length)}\n\n🔗 The file is too large for Telegram. Use the button below (valid for 15 minutes).`
      : backupCaption(backup, bytes.length);
  await safeEdit(ctx, msg.chat.id, loading.message_id, text, link ? { reply_markup: markup([[urlBtn('⬇️ Download Backup', link)]]) } : {});
  await reactOk(ctx, msg, '👍');
  return undefined;
}

export { esc, btn };
