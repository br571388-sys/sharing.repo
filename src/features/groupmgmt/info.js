// Group information: /info /chatinfo /groupid /userinfo /whois /link /invite /setdescription /settitle,
import { logModerationLogged } from '../../core/activityLog.js';
// plus the moderation history commands /modlog /adminlog /modhistory.
// Only information Telegram actually provides to bots is shown.

import { getGroup, listGroupAdmins } from '../../database/groups.js';
import { countModerationLogs, countWarnings, recentModerationLogs } from '../../database/groupMod.js';
import { esc, field, messages } from '../../utils/formatter.js';
import { reply } from '../../handlers/helpers.js';
import { formatDateTimeIST } from '../../services/timezone.js';
import { senderOf } from '../../core/permissions.js';
import { btn, markup } from '../../keyboards/inlineKeyboard.js';
import { botRightProblem, resolveTarget, senderRight, tgFailure, userLabel } from './util.js';
import { logModeration } from '../../database/groupMod.js';
import { boxHtml } from '../../ui/design.js';

const STATUS_LABEL = { creator: '👑 Group owner', administrator: '🛡️ Administrator', member: '👤 Member', restricted: '🔇 Restricted', left: '🚪 Not in group', kicked: '🔨 Banned' };

export async function infoCommand(ctx, msg) {
  const group = await getGroup(ctx.db, msg.chat.id);
  let chat = msg.chat; let count = null; let admins = [];
  try { chat = { ...msg.chat, ...(await ctx.tg.getChat(msg.chat.id)) }; } catch { /* use what we have */ }
  try { count = await ctx.tg.getChatMemberCount(msg.chat.id); } catch { /* unknown */ }
  try { admins = await ctx.tg.getChatAdministrators(msg.chat.id); } catch { /* unknown */ }
  const authorised = await listGroupAdmins(ctx.db, group);
  return reply(ctx, msg, [
    '📊 <b>GROUP INFORMATION</b>', '',
    field('📌', 'Title', chat.title || '—'),
    field('🆔', 'Chat ID', chat.id),
    field('🏷️', 'Type', chat.type),
    chat.username ? field('🔗', 'Username', `@${chat.username}`) : null,
    count !== null ? field('👥', 'Members', count) : null,
    admins.length ? field('🛡️', 'Administrators', admins.filter((a) => !a.user.is_bot).length) : null,
    field('🔑', 'Authorised for backups', authorised.length),
    chat.description ? field('📝', 'Description', chat.description.slice(0, 300)) : null,
    field('📅', 'Registered with bot', formatDateTimeIST(group.joined_at)),
  ].filter(Boolean).join('\n'));
}

export async function groupidCommand(ctx, msg) {
  return reply(ctx, msg, `${boxHtml("🆔", "Group ID")}\n\n<code>${msg.chat.id}</code>`);
}

export async function userinfoCommand(ctx, msg, args) {
  const t = await resolveTarget(ctx, msg, args);
  let target;
  if (t.ok) target = t.target;
  else if (t.error) return reply(ctx, msg, t.error);
  else target = { id: senderOf(msg)?.id ?? msg.from.id, user: msg.from };

  let member = null;
  try { member = await ctx.tg.getChatMember(msg.chat.id, target.id); } catch { /* not resolvable */ }
  const user = member?.user || target.user;
  if (!user) return reply(ctx, msg, messages.warning('User Not Found', 'Telegram does not know that user in this group.'));
  const group = await getGroup(ctx.db, msg.chat.id);
  const isAdmin = (await senderRight(ctx, msg, null)).ok;
  const lines = [
    '👤 <b>USER INFORMATION</b>', '',
    field('🆔', 'ID', user.id),
    field('📛', 'Name', [user.first_name, user.last_name].filter(Boolean).join(' ') || '—'),
    user.username ? field('🔗', 'Username', `@${user.username}`) : null,
    user.is_bot ? field('🤖', 'Account', 'bot') : null,
    member ? field('🏷️', 'Status here', STATUS_LABEL[member.status] || member.status) : null,
    member?.custom_title ? field('🎖️', 'Title', member.custom_title) : null,
    isAdmin ? field('⚠️', 'Warnings', await countWarnings(ctx.db, group, user.id)) : null,
    field('🔗', 'Profile', `<a href="tg://user?id=${user.id}">open</a>`, { raw: true }),
  ].filter(Boolean);
  return reply(ctx, msg, lines.join('\n'));
}

export async function linkCommand(ctx, msg) {
  const sr = await senderRight(ctx, msg, null);
  if (!sr.ok) return reply(ctx, msg, sr.error);
  let chat;
  try { chat = await ctx.tg.getChat(msg.chat.id); } catch (e) { return reply(ctx, msg, tgFailure(e, 'read the group')); }
  if (chat.username) return reply(ctx, msg, `${boxHtml("🔗", "Group Link")}\n\nhttps://t.me/${esc(chat.username)}`);
  if (chat.invite_link) return reply(ctx, msg, `${boxHtml("🔗", "Group Link")}\n\n${esc(chat.invite_link)}`);
  const problem = await botRightProblem(ctx, msg.chat.id, 'can_invite_users');
  if (problem) return reply(ctx, msg, problem);
  try {
    const link = await ctx.tg.exportChatInviteLink(msg.chat.id);
    return reply(ctx, msg, `${boxHtml("🔗", "Group Link")}\n\n${esc(link)}`);
  } catch (e) { return reply(ctx, msg, tgFailure(e, 'get the group link')); }
}

export async function inviteCommand(ctx, msg) {
  const sr = await senderRight(ctx, msg, 'can_invite_users');
  if (!sr.ok) return reply(ctx, msg, sr.error);
  const problem = await botRightProblem(ctx, msg.chat.id, 'can_invite_users');
  if (problem) return reply(ctx, msg, problem);
  try {
    const link = await ctx.tg.createChatInviteLink(msg.chat.id, { name: `Invite by ${msg.from.first_name || msg.from.id}`.slice(0, 32) });
    const group = await getGroup(ctx.db, msg.chat.id);
    await logModerationLogged(ctx, group, { action: 'invite', moderator: msg.from.id });
    return reply(ctx, msg, `${boxHtml("🔗", "NEW INVITE LINK")}\n\n${esc(link.invite_link)}`);
  } catch (e) { return reply(ctx, msg, tgFailure(e, 'create the invite link')); }
}

async function changeInfo(ctx, msg, args, what) {
  const sr = await senderRight(ctx, msg, 'can_change_info');
  if (!sr.ok) return reply(ctx, msg, sr.error);
  const problem = await botRightProblem(ctx, msg.chat.id, 'can_change_info');
  if (problem) return reply(ctx, msg, problem);
  const text = (args.trim() || (what === 'title' ? '' : msg.reply_to_message?.text || '')).trim();
  if (!text) return reply(ctx, msg, messages.usage([`/set${what} <text>`], [what === 'title' ? '/settitle My Group' : '/setdescription Friendly chat about anime']));
  if (what === 'title' && text.length > 128) return reply(ctx, msg, messages.warning('Title Too Long', 'Group titles can have at most 128 characters.'));
  if (what === 'description' && text.length > 255) return reply(ctx, msg, messages.warning('Description Too Long', 'Group descriptions can have at most 255 characters.'));
  const group = await getGroup(ctx.db, msg.chat.id);
  try {
    if (what === 'title') await ctx.tg.setChatTitle(msg.chat.id, text); else await ctx.tg.setChatDescription(msg.chat.id, text);
  } catch (e) { return reply(ctx, msg, tgFailure(e, `change the ${what}`)); }
  await logModerationLogged(ctx, group, { action: `set${what}`, moderator: msg.from.id, reason: text.slice(0, 100) });
  return reply(ctx, msg, `✅ <b>GROUP ${what.toUpperCase()} UPDATED</b>\n\n${field('📝', what === 'title' ? 'Title' : 'Description', text)}`);
}
export const settitleCommand = (ctx, msg, args) => changeInfo(ctx, msg, args, 'title');
export const setdescriptionCommand = (ctx, msg, args) => changeInfo(ctx, msg, args, 'description');

// ---------------------------------------------------------------- moderation history
const PAGE = 8;
const ICON = { ban: '🔨', unban: '🔓', kick: '👢', mute: '🔇', unmute: '🔊', warn: '⚠️', unwarn: '✅', del: '🗑️', purge: '🧹', pin: '📌', promote: '⬆️', demote: '⬇️', lock: '🔒', unlock: '🔓', report: '🚨', antiflood: '🌊', antispam: '🚫' };

async function historyPage(ctx, group, userId, page) {
  const total = await countModerationLogs(ctx.db, group, userId);
  const rows = await recentModerationLogs(ctx.db, group, { userId, limit: PAGE, offset: page * PAGE });
  const lines = rows.map((r) => `${ICON[r.action] || '•'} <b>${esc(r.action)}</b> ${r.target_user_id ? userLabel(null, r.target_user_id) : ''}${r.moderator_id ? ` by ${userLabel(null, r.moderator_id)}` : ' <i>(automatic)</i>'}\n   ${r.reason ? `📝 ${esc(r.reason.slice(0, 120))}\n   ` : ''}🕒 ${formatDateTimeIST(r.created_at)}${r.result !== 'success' ? ` — ⚠️ ${esc(r.result)}` : ''}`);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const nav = [];
  const tag = userId ? userId : 0;
  if (page > 0) nav.push(btn('⬅️ Newer', `ml:${tag}:${page - 1}`));
  if (page + 1 < pages) nav.push(btn('Older ➡️', `ml:${tag}:${page + 1}`));
  return {
    text: `📋 <b>MODERATION LOG</b>${userId ? ` — ${userLabel(null, userId)}` : ''}\n\n${lines.join('\n\n') || 'No events recorded yet.'}\n\n<i>Page ${page + 1}/${pages} • ${total} event(s)</i>`,
    keyboard: markup([nav]),
  };
}

export async function modlogCommand(ctx, msg, args) {
  const sr = await senderRight(ctx, msg, null);
  if (!sr.ok) return reply(ctx, msg, sr.error);
  const group = await getGroup(ctx.db, msg.chat.id);
  const t = await resolveTarget(ctx, msg, args);
  const page = await historyPage(ctx, group, t.ok ? t.target.id : null, 0);
  return reply(ctx, msg, page.text, { reply_markup: page.keyboard });
}

/** ml:<userId|0>:<page> — admins only, scoped to THIS chat's group. */
export async function modlogCallback(ctx, cq, parts) {
  const chat = cq.message?.chat;
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return ctx.tg.answerCallbackQuery(cq.id, 'Groups only.', true);
  const sr = await senderRight(ctx, { chat, from: cq.from }, null);
  if (!sr.ok) return ctx.tg.answerCallbackQuery(cq.id, '🔒 Only admins can view the moderation log.', true);
  const userId = Number(parts[1]) || null;
  const pg = Math.max(0, Number.parseInt(parts[2], 10) || 0);
  const group = await getGroup(ctx.db, chat.id);
  const page = await historyPage(ctx, group, userId, pg);
  await ctx.tg.answerCallbackQuery(cq.id);
  await ctx.tg.editMessageText(chat.id, cq.message.message_id, page.text, { reply_markup: page.keyboard }).catch(() => {});
  return undefined;
}
