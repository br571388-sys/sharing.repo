// Admin management: /promote /admin /demote /unadmin /admins /adminlist /staff /sync.
import { logModerationLogged } from '../../core/activityLog.js';
// Promotions are only reported as successful after Telegram confirms AND a follow-up getChatMember shows the new role.

import { getGroup, listGroupAdmins, removeGroupAdmin, setGroupOwner, upsertGroup } from '../../database/groups.js';
import { logModeration } from '../../database/groupMod.js';
import { esc, field, messages } from '../../utils/formatter.js';
import { reply } from '../../handlers/helpers.js';
import { senderOf } from '../../core/permissions.js';
import { botMember, botRightProblem, protectedReason, resolveTarget, senderRight, tgFailure, userLabel } from './util.js';
import { boxHtml } from '../../ui/design.js';

const RIGHTS = {
  delete: 'can_delete_messages', restrict: 'can_restrict_members', ban: 'can_restrict_members', pin: 'can_pin_messages',
  invite: 'can_invite_users', info: 'can_change_info', promote: 'can_promote_members', video: 'can_manage_video_chats',
};
const BASIC = ['can_delete_messages', 'can_restrict_members', 'can_pin_messages', 'can_invite_users'];
const ALL = ['can_delete_messages', 'can_restrict_members', 'can_pin_messages', 'can_invite_users', 'can_change_info', 'can_manage_video_chats', 'can_promote_members'];
const NO_RIGHTS = Object.fromEntries([...ALL, 'can_manage_topics', 'can_post_stories', 'can_edit_stories', 'can_delete_stories', 'can_manage_chat'].map((k) => [k, false]));

/** Parses "[rights] [custom title]". Rights: `all`, `basic`, or words like delete,pin,restrict,invite,info,promote,video. */
export function parsePromoteArgs(rest) {
  const m = /^(\S+)([\s\S]*)$/.exec(rest.trim());
  if (!m) return { rights: BASIC, title: '' };
  const tokens = m[1].toLowerCase().split(',');
  if (tokens.every((t) => t === 'all' || t === 'basic' || RIGHTS[t])) {
    const rights = tokens.includes('all') ? ALL : tokens.includes('basic') ? BASIC : [...new Set(tokens.map((t) => RIGHTS[t]))];
    return { rights, title: m[2].trim().slice(0, 16) };
  }
  return { rights: BASIC, title: rest.trim().slice(0, 16) };
}

async function promote(ctx, msg, args) {
  const { chat } = msg;
  const sr = await senderRight(ctx, msg, 'can_promote_members');
  if (!sr.ok) return reply(ctx, msg, sr.error);
  const problem = await botRightProblem(ctx, chat.id, 'can_promote_members');
  if (problem) return reply(ctx, msg, problem);

  const t = await resolveTarget(ctx, msg, args);
  if (!t.ok) return reply(ctx, msg, t.error || messages.usage(['/promote (reply) [rights] [title]', '/promote <user id> [rights] [title]'], ['/promote pin,delete Moderator'], 'Rights: basic (default), all, or a list of delete, restrict, pin, invite, info, promote, video.'));
  const target = t.target;
  if (target.id === senderOf(msg).id) return reply(ctx, msg, messages.warning('Not Allowed', 'You cannot promote yourself.'));
  const prot = await protectedReason(ctx, chat.id, target.id, { allowAdmins: true });
  if (prot) return reply(ctx, msg, messages.warning('Protected User', prot));
  const member = await ctx.tg.getChatMember(chat.id, target.id).catch(() => null);
  if (!member || ['left', 'kicked'].includes(member.status)) return reply(ctx, msg, messages.warning('Not a Member', 'That user is not in this group.'));

  const bot = await botMember(ctx, chat.id);
  const { rights, title } = parsePromoteArgs(t.rest);
  // Telegram only lets a bot hand out rights it holds itself.
  const granted = bot.status === 'creator' ? rights : rights.filter((r) => bot[r] !== false);
  const dropped = rights.filter((r) => !granted.includes(r));
  if (!granted.length) return reply(ctx, msg, messages.warning('Nothing to Grant', 'I do not hold any of those rights myself, so I cannot hand them out.'));

  const group = await getGroup(ctx.db, chat.id);
  try {
    await ctx.tg.promoteChatMember(chat.id, target.id, { ...NO_RIGHTS, is_anonymous: false, ...Object.fromEntries(granted.map((r) => [r, true])) });
    const after = await ctx.tg.getChatMember(chat.id, target.id);
    if (after?.status !== 'administrator') throw new Error('promotion not visible after the call');
    if (title) await ctx.tg.setChatAdministratorCustomTitle(chat.id, target.id, title).catch(() => {});
  } catch (e) {
    await logModerationLogged(ctx, group, { action: 'promote', target: target.id, moderator: msg.from.id, result: `failed: ${String(e?.message).slice(0, 100)}` });
    return reply(ctx, msg, tgFailure(e, 'promote the user'));
  }
  await logModerationLogged(ctx, group, { action: 'promote', target: target.id, moderator: msg.from.id, reason: granted.join(', ') });
  const names = granted.map((r) => r.replace('can_', '').replace(/_/g, ' ')).join(', ');
  return reply(ctx, msg, [
    '⬆️ <b>USER PROMOTED</b>', '',
    field('👤', 'User', userLabel(member.user || target.user, target.id), { raw: true }),
    field('🛡️', 'By', userLabel(msg.from, msg.from.id), { raw: true }),
    field('🔑', 'Rights', names),
    title ? field('🏷️', 'Title', title) : null,
    dropped.length ? `⚠️ Not granted (I do not hold them): ${dropped.map((r) => r.replace('can_', '').replace(/_/g, ' ')).join(', ')}` : null,
  ].filter(Boolean).join('\n'));
}

export const promoteCommand = (ctx, msg, args) => promote(ctx, msg, args);

export async function demoteCommand(ctx, msg, args) {
  const { chat } = msg;
  const sr = await senderRight(ctx, msg, 'can_promote_members');
  if (!sr.ok) return reply(ctx, msg, sr.error);
  const problem = await botRightProblem(ctx, chat.id, 'can_promote_members');
  if (problem) return reply(ctx, msg, problem);
  const t = await resolveTarget(ctx, msg, args);
  if (!t.ok) return reply(ctx, msg, t.error || messages.usage(['/demote (reply)', '/demote <user id>']));
  const target = t.target;
  if (target.id === senderOf(msg).id) return reply(ctx, msg, messages.warning('Not Allowed', 'You cannot demote yourself.'));
  const prot = await protectedReason(ctx, chat.id, target.id, { allowAdmins: true });
  if (prot) return reply(ctx, msg, messages.warning('Protected User', prot));
  const before = await ctx.tg.getChatMember(chat.id, target.id).catch(() => null);
  if (before?.status !== 'administrator') return reply(ctx, msg, messages.warning('Not an Administrator', 'That user is not an administrator.'));

  const group = await getGroup(ctx.db, chat.id);
  try {
    await ctx.tg.promoteChatMember(chat.id, target.id, { ...NO_RIGHTS, is_anonymous: false });
    const after = await ctx.tg.getChatMember(chat.id, target.id);
    if (after?.status === 'administrator') throw new Error('CHAT_ADMIN_REQUIRED: still administrator');
  } catch (e) {
    await logModerationLogged(ctx, group, { action: 'demote', target: target.id, moderator: msg.from.id, result: `failed: ${String(e?.message).slice(0, 100)}` });
    return reply(ctx, msg, `${tgFailure(e, 'demote the user')}\n\n💡 Telegram only lets me demote administrators that <i>I</i> promoted.`);
  }
  await removeGroupAdmin(ctx.db, group, target.id).catch(() => {});
  await logModerationLogged(ctx, group, { action: 'demote', target: target.id, moderator: msg.from.id });
  return reply(ctx, msg, `${boxHtml("⬇️", "USER DEMOTED")}\n\n${field('👤', 'User', userLabel(before.user || target.user, target.id), { raw: true })}\n${field('🛡️', 'By', userLabel(msg.from, msg.from.id), { raw: true })}`);
}

async function fetchAdmins(ctx, chatId) {
  const list = await ctx.tg.getChatAdministrators(chatId);
  return list.filter((a) => a.user);
}

const adminLine = (a) => {
  const icon = a.status === 'creator' ? '👑' : a.user.is_bot ? '🤖' : '🛡️';
  const name = a.user.username ? `@${esc(a.user.username)}` : esc([a.user.first_name, a.user.last_name].filter(Boolean).join(' ') || `User ${a.user.id}`);
  return `${icon} ${name}${a.custom_title ? ` — <i>${esc(a.custom_title)}</i>` : ''}`;
};

export async function adminsCommand(ctx, msg) {
  let admins;
  try { admins = await fetchAdmins(ctx, msg.chat.id); } catch (e) { return reply(ctx, msg, tgFailure(e, 'read the administrator list')); }
  const ordered = [...admins.filter((a) => a.status === 'creator'), ...admins.filter((a) => a.status !== 'creator' && !a.user.is_bot), ...admins.filter((a) => a.user.is_bot && a.status !== 'creator')];
  return reply(ctx, msg, `👮 <b>Group Administrators</b> (${ordered.length})\n\n${ordered.map(adminLine).join('\n')}`);
}

export async function staffCommand(ctx, msg) {
  const group = await getGroup(ctx.db, msg.chat.id);
  let admins;
  try { admins = await fetchAdmins(ctx, msg.chat.id); } catch (e) { return reply(ctx, msg, tgFailure(e, 'read the administrator list')); }
  const humans = admins.filter((a) => !a.user.is_bot);
  const authorised = await listGroupAdmins(ctx.db, group);
  const authLines = authorised.map((a) => `🔑 ${userLabel(null, a.telegram_user_id)}`);
  return reply(ctx, msg, [
    '👥 <b>Group Staff</b>', '',
    humans.filter((a) => a.status === 'creator').map(adminLine).join('\n') || null,
    humans.filter((a) => a.status !== 'creator').map(adminLine).join('\n') || null,
    authLines.length ? `\n🔐 <b>Authorised for backups</b>\n${authLines.join('\n')}` : null,
  ].filter(Boolean).join('\n'));
}

/** /sync — re-reads title, owner and administrators from Telegram and drops authorisations of people who are no longer admins. */
export async function syncCommand(ctx, msg) {
  const sr = await senderRight(ctx, msg, null);
  if (!sr.ok) return reply(ctx, msg, sr.error);
  let admins; let chat;
  try {
    [admins, chat] = await Promise.all([fetchAdmins(ctx, msg.chat.id), ctx.tg.getChat(msg.chat.id)]);
  } catch (e) { return reply(ctx, msg, tgFailure(e, 'sync with Telegram')); }
  const creator = admins.find((a) => a.status === 'creator' && !a.user.is_bot);
  const { group } = await upsertGroup(ctx.db, { ...msg.chat, title: chat?.title || msg.chat.title, username: chat?.username || null });
  if (creator && Number(group.owner_user_id) !== creator.user.id) await setGroupOwner(ctx.db, msg.chat.id, creator.user.id, 'telegram');
  const adminIds = new Set(admins.map((a) => a.user.id));
  let removed = 0;
  for (const a of await listGroupAdmins(ctx.db, group)) {
    if (!adminIds.has(Number(a.telegram_user_id)) && (await removeGroupAdmin(ctx.db, group, a.telegram_user_id))) removed++;
  }
  return reply(ctx, msg, `${boxHtml("🔄", "SYNC COMPLETE")}\n\n${field('📌', 'Title', chat?.title || msg.chat.title || '—')}\n${field('👑', 'Owner', creator ? userLabel(creator.user, creator.user.id) : 'hidden / not identified', { raw: true })}\n${field('🛡️', 'Administrators', admins.length)}\n${field('🧹', 'Stale authorisations removed', removed)}`);
}
