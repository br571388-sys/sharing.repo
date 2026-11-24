// Reports: members reply /report to a message; moderators are notified and can act with buttons.
import { logModerationLogged } from '../../core/activityLog.js';
// Commands: /report /reports /reportmode /clearreports.

import { getGroup } from '../../database/groups.js';
import { closeAllReports, closeReport, createReport, getReport, listOpenReports, logModeration } from '../../database/groupMod.js';
import { hitRateLimit } from '../../database/state.js';
import { setGroupSetting } from '../../database/settings.js';
import { btn, markup } from '../../keyboards/inlineKeyboard.js';
import { esc, field, messages } from '../../utils/formatter.js';
import { truncate } from '../../utils/helpers.js';
import { reply } from '../../handlers/helpers.js';
import { formatDateTimeIST } from '../../services/timezone.js';
import { applyRestriction } from './moderation.js';
import { loadSettings } from './settings.js';
import { botRightProblem, isExempt, senderRight, tryDelete, userLabel } from './util.js';
import { boxHtml } from '../../ui/design.js';

const MODES = ['group', 'pm', 'off'];

async function adminMentions(ctx, chatId) {
  try {
    const admins = await ctx.tg.getChatAdministrators(chatId);
    return admins.filter((a) => a.user && !a.user.is_bot).slice(0, 8).map((a) => a.user);
  } catch { return []; }
}

const reportButtons = (id) => markup([
  [btn('✅ Resolve', `rp:ok:${id}`), btn('❌ Dismiss', `rp:no:${id}`)],
  [btn('🗑 Delete message', `rp:del:${id}`), btn('🔨 Ban sender', `rp:ban:${id}`)],
]);

export async function reportCommand(ctx, msg) {
  const { chat, from } = msg;
  const group = await getGroup(ctx.db, chat.id);
  const settings = await loadSettings(ctx, group);
  const target = msg.reply_to_message;
  if (settings.get('reports.mode') === 'off') return reply(ctx, msg, messages.warning('Reports Are Off', 'This group does not accept reports.'));
  if (!target) return reply(ctx, msg, messages.usage(['/report (reply to the message you want to report)'], [], 'Admins will be notified.'));
  if (!from || from.is_bot) return undefined;
  const info = await ctx.botInfo();
  if (target.from?.id === from.id) return reply(ctx, msg, messages.warning('Not Allowed', 'You cannot report your own message.'));
  if (target.from?.id === info.id || target.from?.is_bot) return reply(ctx, msg, messages.warning('Not Allowed', 'Bots cannot be reported this way.'));
  if (target.from && (await isExempt(ctx, chat.id, target.from.id))) return reply(ctx, msg, messages.warning('Not Allowed', 'Administrators cannot be reported.'));
  if ((await hitRateLimit(ctx.db, `rep:${chat.id}:${from.id}`, 3, 600)).allowed === false) return reply(ctx, msg, messages.rateLimited(60));

  const excerpt = truncate(target.text ?? target.caption ?? (target.photo ? '[photo]' : target.video ? '[video]' : target.document ? '[document]' : target.sticker ? '[sticker]' : '[message]'), 200);
  const { id, duplicate } = await createReport(ctx.db, group, { reporterId: from.id, reportedUserId: target.from?.id ?? null, messageId: target.message_id, excerpt });
  if (duplicate) return reply(ctx, msg, messages.success('Already Reported', 'Admins were already notified about this message.'));
  await logModerationLogged(ctx, group, { action: 'report', target: target.from?.id ?? null, moderator: from.id, messageId: target.message_id, reason: excerpt });

  const link = chat.username ? `https://t.me/${chat.username}/${target.message_id}` : (String(chat.id).startsWith('-100') ? `https://t.me/c/${String(chat.id).slice(4)}/${target.message_id}` : null);
  const body = [
    '🚨 <b>NEW REPORT</b>', '',
    field('📍', 'Group', chat.title || chat.id),
    field('👤', 'Reported user', target.from ? userLabel(target.from, target.from.id) : 'unknown', { raw: true }),
    field('📣', 'Reported by', userLabel(from, from.id), { raw: true }),
    field('💬', 'Message', excerpt),
    link ? `🔗 <a href="${esc(link)}">Open the message</a>` : null,
  ].filter(Boolean).join('\n');

  const mode = settings.get('reports.mode');
  let delivered = 0;
  if (mode === 'pm') {
    for (const admin of await adminMentions(ctx, chat.id)) {
      try { await ctx.tg.sendMessage(admin.id, body, { reply_markup: reportButtons(id) }); delivered++; } catch { /* admin never started the bot */ }
    }
  }
  if (mode === 'group' || delivered === 0) {
    const admins = await adminMentions(ctx, chat.id);
    const hidden = admins.map((a) => `<a href="tg://user?id=${a.id}">⁣</a>`).join('');
    await ctx.tg.sendMessage(chat.id, `${body}${hidden}`, { reply_markup: reportButtons(id), reply_parameters: { message_id: target.message_id, allow_sending_without_reply: true } }).catch(() => {});
    delivered++;
  }
  await tryDelete(ctx, chat.id, msg.message_id);
  await ctx.tg.sendMessage(from.id, `✅ Your report in <b>${esc(chat.title || 'the group')}</b> was sent to the admins.`).catch(() => {});
  return undefined;
}

export async function reportsCommand(ctx, msg) {
  const sr = await senderRight(ctx, msg, null);
  if (!sr.ok) return reply(ctx, msg, sr.error);
  const group = await getGroup(ctx.db, msg.chat.id);
  const rows = await listOpenReports(ctx.db, group);
  if (!rows.length) return reply(ctx, msg, `${boxHtml("📢", "Reports")}\n\nNo open reports. 🎉`);
  const text = rows.map((r) => `#${r.id} — ${r.reported_user_id ? userLabel(null, r.reported_user_id) : 'unknown'} <i>(${formatDateTimeIST(r.created_at)})</i>\n   ${esc(r.excerpt || '')}`).join('\n\n');
  return reply(ctx, msg, `📢 <b>Open Reports</b> (${rows.length})\n\n${text}\n\nClose them all with /clearreports.`);
}

export async function reportmodeCommand(ctx, msg, args) {
  const sr = await senderRight(ctx, msg, null);
  if (!sr.ok) return reply(ctx, msg, sr.error);
  const group = await getGroup(ctx.db, msg.chat.id);
  const m = args.trim().toLowerCase();
  if (!m) return reply(ctx, msg, `${boxHtml("📢", "Report Mode")}\n\n${field('🎛️', 'Current', (await loadSettings(ctx, group)).get('reports.mode'))}\n\n<code>/reportmode group</code> — post in the group, tagging admins silently\n<code>/reportmode pm</code> — message admins privately (falls back to the group)\n<code>/reportmode off</code> — disable reports`);
  if (!MODES.includes(m)) return reply(ctx, msg, messages.usage(['/reportmode <group|pm|off>']));
  await setGroupSetting(ctx.db, group, 'reports.mode', m);
  return reply(ctx, msg, `${boxHtml("📢", "REPORT MODE UPDATED")}\n\n${field('🎛️', 'Mode', m)}`);
}

export async function clearreportsCommand(ctx, msg) {
  const sr = await senderRight(ctx, msg, null);
  if (!sr.ok) return reply(ctx, msg, sr.error);
  const group = await getGroup(ctx.db, msg.chat.id);
  const n = await closeAllReports(ctx.db, group, msg.from.id);
  return reply(ctx, msg, messages.success('Reports Cleared', `${n} open report(s) were closed.`));
}

/** rp:<ok|no|del|ban>:<reportId> */
export async function reportCallback(ctx, cq, parts) {
  const chat = cq.message?.chat;
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup' && chat.type !== 'private')) return ctx.tg.answerCallbackQuery(cq.id, 'Unavailable here.', true);
  // Reports can also be delivered privately: find the group through the report row.
  const reportId = Number(parts[2]);
  const row = await ctx.db.first('SELECT r.*, g.telegram_chat_id FROM group_reports r JOIN groups g ON g.id = r.group_id WHERE r.id = ?', [reportId]);
  if (!row) return ctx.tg.answerCallbackQuery(cq.id, 'Report not found.', true);
  const groupChat = { id: row.telegram_chat_id };
  const sr = await senderRight(ctx, { chat: groupChat, from: cq.from }, null);
  if (!sr.ok) return ctx.tg.answerCallbackQuery(cq.id, '🔒 Only group admins can handle reports.', true);
  const group = await getGroup(ctx.db, row.telegram_chat_id);
  const report = await getReport(ctx.db, group, reportId);
  if (!report || report.status !== 'open') return ctx.tg.answerCallbackQuery(cq.id, 'This report was already handled.', true);

  const action = parts[1];
  let done = '';
  if (action === 'del') {
    if (!(await tryDelete(ctx, groupChat.id, report.reported_message_id))) return ctx.tg.answerCallbackQuery(cq.id, 'I could not delete that message (gone, too old, or no permission).', true);
    done = '🗑 Message deleted';
  } else if (action === 'ban') {
    const sr2 = await senderRight(ctx, { chat: groupChat, from: cq.from }, 'can_restrict_members');
    if (!sr2.ok) return ctx.tg.answerCallbackQuery(cq.id, '🔒 You need the “Ban users” right.', true);
    if (!report.reported_user_id || (await botRightProblem(ctx, groupChat.id, 'can_restrict_members')) || (await isExempt(ctx, groupChat.id, report.reported_user_id))) {
      return ctx.tg.answerCallbackQuery(cq.id, 'I cannot ban that user (missing rights or protected).', true);
    }
    const res = await applyRestriction(ctx, groupChat, group, report.reported_user_id, 'ban', { reason: `Report #${reportId}`, moderator: cq.from.id, messageId: report.reported_message_id });
    if (!res.ok) return ctx.tg.answerCallbackQuery(cq.id, 'Telegram did not allow the ban.', true);
    await tryDelete(ctx, groupChat.id, report.reported_message_id);
    done = '🔨 User banned';
  } else if (action === 'ok') done = '✅ Resolved';
  else if (action === 'no') done = '❌ Dismissed';
  else return ctx.tg.answerCallbackQuery(cq.id, 'Unknown button.', true);

  if (!(await closeReport(ctx.db, group, reportId, action === 'no' ? 'dismissed' : 'resolved', cq.from.id))) return ctx.tg.answerCallbackQuery(cq.id, 'Already handled.', true);
  await logModerationLogged(ctx, group, { action: `report_${action}`, target: report.reported_user_id, moderator: cq.from.id, messageId: report.reported_message_id });
  await ctx.tg.answerCallbackQuery(cq.id, done);
  await ctx.tg.editMessageText(chat.id, cq.message.message_id, `📢 <b>REPORT #${reportId} CLOSED</b>\n\n${done}\n${field('🛡️', 'By', userLabel(cq.from, cq.from.id), { raw: true })}`).catch(() => {});
  return undefined;
}
