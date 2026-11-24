// Shared building blocks for every group-management command: argument parsing (reply / user id / @username /
// text mention), durations, Telegram right checks, protection rules and truthful error mapping.

import { Role, getMemberStatus, isBotOwner, senderOf } from '../../core/permissions.js';
import { TelegramError } from '../../utils/errors.js';
import { esc, mention, messages } from '../../utils/formatter.js';
import { formatDateTimeIST } from '../../services/timezone.js';
import { displayName, reply } from '../../handlers/helpers.js';
import { nowSec } from '../../utils/helpers.js';

export const isGroupChat = (chat) => chat?.type === 'group' || chat?.type === 'supergroup';

// ------------------------------------------------------------------ durations
export const MIN_DURATION = 30; // Telegram treats restrictions shorter than 30 s as permanent
export const MAX_DURATION = 366 * 86400; // ... and longer than 366 days as permanent

const UNITS = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

/** "30s" "10m" "2h" "1d" "1w" -> seconds. Returns null when the token is not a duration. */
export function parseDuration(token) {
  const m = /^(\d{1,6})([smhdw])$/i.exec(String(token || '').trim());
  if (!m) return null;
  return Number(m[1]) * UNITS[m[2].toLowerCase()];
}

export const durationInRange = (sec) => sec >= MIN_DURATION && sec <= MAX_DURATION;

export function formatDuration(sec) {
  if (!sec) return 'Permanent';
  const parts = [];
  let rest = sec;
  for (const [label, size] of [['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]]) {
    const n = Math.floor(rest / size);
    if (n) { parts.push(`${n} ${label}${n === 1 ? '' : 's'}`); rest -= n * size; }
    if (parts.length === 2) break;
  }
  return parts.join(' ') || '0 seconds';
}

export const DURATION_HELP = 'Durations: 30s, 10m, 2h, 1d, 7d, 1w (30 seconds to 366 days).';

// ------------------------------------------------------------------ names
export const userLabel = (user, id) => {
  if (user?.username) return `@${esc(user.username)}`;
  const name = displayName(user || {});
  return mention(id ?? user?.id, user ? name : `User ${id}`);
};

// ------------------------------------------------------------------ target resolution
const ID_RE = /^\d{5,15}$/;

/** Looks up a @username among people the bot actually knows (users who started it, group staff, moderated users). */
async function findByUsername(ctx, msg, name) {
  const clean = name.replace(/^@/, '');
  const known = await ctx.db.first('SELECT telegram_user_id AS id, first_name, last_name, username FROM users WHERE lower(username) = lower(?)', [clean]);
  if (known) return { id: Number(known.id), user: { id: Number(known.id), first_name: known.first_name, last_name: known.last_name, username: known.username } };
  try {
    const admins = await ctx.tg.getChatAdministrators(msg.chat.id);
    const hit = admins.find((a) => a.user?.username?.toLowerCase() === clean.toLowerCase());
    if (hit) return { id: hit.user.id, user: hit.user };
  } catch { /* ignore */ }
  return null;
}

/**
 * Works out WHO a moderation command targets.
 *   1. a numeric user id as the first word            -> that id (wins over a reply)
 *   2. a @username as the first word                  -> resolved if the bot knows the user
 *   3. a text-mention entity in the command           -> that user
 *   4. the author of the replied-to message           -> that user
 * Returns { ok, target:{id,user}, rest, via } or { ok:false, error }. `rest` is the argument text left over.
 */
export async function resolveTarget(ctx, msg, args) {
  const text = args.trim();
  const m = /^(\S+)([\s\S]*)$/.exec(text);
  const first = m?.[1] || '';
  const after = (m?.[2] || '').replace(/^\s+/, '');

  if (ID_RE.test(first)) return { ok: true, target: { id: Number(first), user: null }, rest: after, via: 'id' };

  if (/^@[A-Za-z0-9_]{4,32}$/.test(first)) {
    const found = await findByUsername(ctx, msg, first);
    if (!found) return { ok: false, error: messages.warning('User Not Found', `I can't resolve ${first}. Reply to one of their messages, or use their numeric user ID.`) };
    return { ok: true, target: found, rest: after, via: 'username' };
  }

  const tm = (msg.entities || []).find((e) => e.type === 'text_mention' && e.user);
  if (tm) return { ok: true, target: { id: tm.user.id, user: tm.user }, rest: text.replace(msg.text?.slice(tm.offset, tm.offset + tm.length) || '\u0000', '').trim(), via: 'mention' };

  const r = msg.reply_to_message;
  if (r) {
    if (r.sender_chat && r.sender_chat.id !== r.from?.id) return { ok: false, error: messages.warning('Cannot Identify User', 'That message was sent as a channel or an anonymous administrator, so I cannot tell who sent it.') };
    if (r.from) return { ok: true, target: { id: r.from.id, user: r.from }, rest: text, via: 'reply' };
  }
  return { ok: false, error: null };
}

/** The message a command acts on (the replied-to message). */
export const repliedMessage = (msg) => msg.reply_to_message || null;

// ------------------------------------------------------------------ Telegram rights
export const RIGHT_LABEL = {
  can_restrict_members: 'Ban users', can_delete_messages: 'Delete messages', can_pin_messages: 'Pin messages',
  can_promote_members: 'Add new admins', can_invite_users: 'Invite users via link', can_change_info: 'Change group info',
};

/** Raw getChatMember for the bot itself. */
export async function botMember(ctx, chatId) {
  const info = await ctx.botInfo();
  return getMemberStatus(ctx, chatId, info.id);
}

/**
 * Checks that the bot is an administrator holding `right`. Returns null when fine, otherwise a ready-to-send message.
 */
export async function botRightProblem(ctx, chatId, right) {
  const m = await botMember(ctx, chatId);
  if (!m) return messages.error('Group Inaccessible', 'I could not read my own status in this group. Make sure I am still a member.');
  if (m.status === 'creator') return null;
  if (m.status !== 'administrator') return messages.warning('I Am Not an Administrator', 'Please make me an administrator first so I can do this.');
  if (right && m[right] === false) return messages.warning('Missing Permission', `I need the “${RIGHT_LABEL[right] || right}” admin right to do this.`);
  return null;
}

/**
 * Does the command sender hold `right` (or is creator / the bot owner)? `right` null = any administrator.
 * Returns { ok, status, member } — ok=false carries a ready message in `error`.
 */
export async function senderRight(ctx, msg, right) {
  const sender = senderOf(msg);
  if (!sender) return { ok: false, error: messages.denied('I cannot verify anonymous administrators. Turn off “Remain anonymous” and try again.') };
  if (isBotOwner(ctx.config, sender.id)) return { ok: true, status: 'owner' };
  const m = await getMemberStatus(ctx, msg.chat.id, sender.id);
  if (m?.status === 'creator') return { ok: true, status: 'creator', member: m };
  if (m?.status === 'administrator') {
    if (!right || m[right] !== false) return { ok: true, status: 'administrator', member: m };
    return { ok: false, error: messages.denied(`You need the “${RIGHT_LABEL[right] || right}” admin right to use this command.`) };
  }
  return { ok: false, error: messages.denied('Only group administrators can use this command.') };
}

/** Admin / creator / authorised / the bot owner / the bot itself must never be moderated by automation or by others. */
export async function protectedReason(ctx, chatId, userId, { allowAdmins = false } = {}) {
  const info = await ctx.botInfo();
  if (Number(userId) === Number(info.id)) return 'I cannot moderate myself.';
  if (isBotOwner(ctx.config, userId)) return 'That user is the bot owner and is protected.';
  const m = await getMemberStatus(ctx, chatId, userId);
  if (m?.status === 'creator') return 'That user is the group owner and cannot be moderated.';
  if (m?.status === 'administrator' && !allowAdmins) return 'That user is an administrator. Demote them first.';
  return null;
}

/** True when the member is exempt from automatic enforcement (admins, creator, bot owner, bots we cannot judge). */
export async function isExempt(ctx, chatId, userId) {
  if (isBotOwner(ctx.config, userId)) return true;
  const { isApproved } = await import('./afkApprove.js');
  if (await isApproved(ctx, chatId, userId).catch(() => false)) return true;
  const m = await getMemberStatus(ctx, chatId, userId);
  return m?.status === 'creator' || m?.status === 'administrator';
}

// ------------------------------------------------------------------ truthful Telegram errors
/** Turns a Telegram failure into an honest, user-safe explanation. Never leaks internals. */
export function tgFailure(e, action = 'do that') {
  const d = String(e?.message || '').toLowerCase();
  const title = `Could Not ${action.charAt(0).toUpperCase()}${action.slice(1)}`.slice(0, 60);
  if (!(e instanceof TelegramError)) return messages.error(title, 'Something unexpected happened. Nothing was changed.');
  let why = 'Telegram refused the request. Nothing was changed.';
  if (d.includes('not enough rights') || d.includes('need administrator rights') || d.includes('chat_admin_required') || d.includes('rights to restrict') || d.includes('have no rights')) why = 'I do not have the required admin right for this. Give me the needed permission and try again.';
  else if (d.includes('user is an administrator') || d.includes('can\'t remove chat owner') || d.includes('can\'t restrict self') || d.includes('can\'t demote chat creator') || d.includes('method is available for supergroup')) why = d.includes('supergroup') ? 'Telegram only allows this in supergroups.' : 'Telegram does not allow this action on an administrator or the group owner.';
  else if (d.includes('user_not_participant') || d.includes('participant_id_invalid') || d.includes('user not found') || d.includes('user_id_invalid')) why = 'That user could not be found in this group.';
  else if (d.includes('message to delete not found') || d.includes('message can\'t be deleted') || d.includes('message to pin not found') || d.includes('message to unpin not found') || d.includes('message_id_invalid')) why = 'That message is gone, too old, or cannot be changed by me.';
  else if (d.includes('chat not found') || d.includes('bot was kicked') || d.includes('not a member')) why = 'I cannot access this group any more.';
  else if (d.includes('too many requests') || e.retryAfter) why = `Telegram is rate limiting me. Please try again in ${e.retryAfter || 'a few'} seconds.`;
  else if (d.includes('timed out') || d.includes('network error')) why = 'Telegram did not answer in time. The action may not have been applied — please check and retry.';
  else if (d.includes('user_creator')) why = 'The group owner cannot be restricted.';
  else if (d.includes('right_forbidden') || d.includes('administrators_too_much')) why = 'Telegram refused to change that administrator\'s rights.';
  return messages.error(title, why);
}

// ------------------------------------------------------------------ confirmations
export const when = () => formatDateTimeIST(nowSec());

/** Sends a reply unless `silent`; always resolves (a failed notification must not hide a successful action). */
export async function notify(ctx, msg, text, { silent = false, extra = {} } = {}) {
  if (silent) return null;
  try { return await reply(ctx, msg, text, extra); } catch { return null; }
}

/** Best-effort delete of the command message (silent / d-variants and /cleancommands). */
export async function tryDelete(ctx, chatId, messageId) {
  try { await ctx.tg.deleteMessage(chatId, messageId); return true; } catch { return false; }
}

export { Role, esc };
