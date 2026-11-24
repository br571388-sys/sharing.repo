// Ban / unban / kick / mute / unmute (+ timed, silent and self variants) and the shared restriction engine used by
import { logModerationLogged } from '../../core/activityLog.js';
// warnings, antiflood, antispam, blacklist, captcha and raid protection.
//
// Rules this file enforces for every action:
//   * the sender must hold the real Telegram right, the bot must hold it too,
//   * admins, the group owner, the bot owner and the bot itself are never moderated,
//   * success is reported ONLY after Telegram confirmed the call,
//   * every outcome (success and failure) is written to the group's moderation log.

import { getGroup } from '../../database/groups.js';
import { activeRestriction, liftRestriction, logModeration, recordRestriction } from '../../database/groupMod.js';
import { senderOf } from '../../core/permissions.js';
import { esc, field, messages } from '../../utils/formatter.js';
import { formatModerationLog } from '../../ui/design.js';
import { btn, markup } from '../../keyboards/inlineKeyboard.js';
import { nowSec } from '../../utils/helpers.js';
import { reply } from '../../handlers/helpers.js';
import { formatDateTimeIST } from '../../services/timezone.js';
import { loadSettings } from './settings.js';
import {
  DURATION_HELP, botRightProblem, durationInRange, formatDuration, notify, parseDuration, protectedReason, resolveTarget,
  senderRight, tgFailure, tryDelete, userLabel,
} from './util.js';

export const MUTED = Object.freeze({
  can_send_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false, can_send_videos: false,
  can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false,
  can_add_web_page_previews: false, can_change_info: false, can_invite_users: false, can_pin_messages: false, can_manage_topics: false,
});

const OPEN = Object.freeze({
  can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true, can_send_videos: true,
  can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
  can_add_web_page_previews: true, can_invite_users: true,
});

/** The group's default member permissions (what an unmuted user gets back). */
export async function defaultPermissions(ctx, chatId) {
  try {
    const chat = await ctx.tg.getChat(chatId);
    if (chat?.permissions && typeof chat.permissions === 'object') return { ...OPEN, ...chat.permissions };
  } catch { /* fall back to open */ }
  return { ...OPEN };
}

const TITLES = {
  ban: ['🚫', 'USER BANNED'], unban: ['🔓', 'USER UNBANNED'], kick: ['👢', 'USER KICKED'], mute: ['🔇', 'USER MUTED'], unmute: ['🔊', 'USER UNMUTED'],
};

/**
 * Runs ONE restriction action against Telegram and records it.
 * Returns { ok:true, expiresAt } or { ok:false, error:<html message>, raw }.
 */
export async function applyRestriction(ctx, chat, group, userId, action, { duration = 0, reason = null, moderator = null, messageId = null } = {}) {
  const untilDate = duration ? nowSec() + duration : 0;
  const log = (result, extra = {}) => logModerationLogged(ctx, group, { action, target: userId, moderator, reason, messageId, result, expiresAt: untilDate || null, ...extra }).catch(() => {});
  try {
    if (action === 'ban') {
      await ctx.tg.banChatMember(chat.id, userId, { untilDate });
      await recordRestriction(ctx.db, group, { userId, kind: 'ban', moderator, reason, expiresAt: untilDate || null });
    } else if (action === 'unban') {
      await ctx.tg.unbanChatMember(chat.id, userId, true);
      await liftRestriction(ctx.db, group, userId, 'ban');
    } else if (action === 'kick') {
      await ctx.tg.banChatMember(chat.id, userId);
      try {
        await ctx.tg.unbanChatMember(chat.id, userId, false);
      } catch (e) {
        await log('partial: removed but unban failed');
        return { ok: false, partial: true, error: messages.warning('Kicked, but Still Banned', 'The user was removed, but I could not lift the ban, so they cannot rejoin yet. Use /unban to allow it.'), raw: e };
      }
    } else if (action === 'mute') {
      await ctx.tg.restrictChatMember(chat.id, userId, MUTED, { untilDate });
      await recordRestriction(ctx.db, group, { userId, kind: 'mute', moderator, reason, expiresAt: untilDate || null });
    } else if (action === 'unmute') {
      await ctx.tg.restrictChatMember(chat.id, userId, await defaultPermissions(ctx, chat.id));
      await liftRestriction(ctx.db, group, userId, 'mute');
    } else {
      throw new Error(`unknown action ${action}`);
    }
  } catch (e) {
    await log(`failed: ${String(e?.message).slice(0, 120)}`);
    return { ok: false, error: tgFailure(e, action), raw: e };
  }
  await log('success');
  return { ok: true, expiresAt: untilDate || null };
}

const NOTES = {
  ban: 'Member removed from the group and blocked from rejoining.',
  unban: 'The ban was lifted. The user may join again.',
  kick: 'Member removed. They can rejoin with an invite link.',
  mute: 'Member can no longer send messages.',
  unmute: 'Member can send messages again.',
};

function confirmation(action, { target, targetId, moderator, reason, chat, duration, expiresAt }) {
  const [emoji, titleText] = TITLES[action];
  const timed = action === 'ban' || action === 'mute';
  return formatModerationLog({
    emoji,
    titleText,
    fields: [
      ['👤', 'User', target],
      targetId ? ['🆔', 'User ID', `<code>${esc(targetId)}</code>`] : null,
      moderator ? ['🛡️', 'Admin', moderator] : null,
      reason ? ['📝', 'Reason', esc(reason)] : null,
      timed ? ['⏰', 'Duration', esc(duration ? `${formatDuration(duration)} (until ${formatDateTimeIST(expiresAt)})` : 'Permanent')] : null,
      ['📍', 'Group', esc(chat.title || chat.id)],
    ],
    note: NOTES[action],
  });
}

const undoButton = (action, userId) => {
  // Undo is shown only where a real reversal exists (a kick cannot be "undone": the user simply may rejoin).
  if (action === 'ban') return markup([[btn('↩️ Undo Ban', `mod:unban:${userId}`)]]);
  if (action === 'mute') return markup([[btn('↩️ Undo Mute', `mod:unmute:${userId}`)]]);
  return undefined;
};

const NAMES = {
  ban: { usage: ['/ban (reply) [reason]', '/ban <user id> [reason]'], example: '/ban 123456789 Spamming' },
  sban: { usage: ['/sban (reply) [reason]', '/sban <user id> [reason]'], example: '/sban 123456789 Spam' },
  tban: { usage: ['/tban (reply) <duration> [reason]', '/tban <user id> <duration> [reason]'], example: '/tban 123456789 2h Repeated spam' },
  unban: { usage: ['/unban (reply)', '/unban <user id>'], example: '/unban 123456789' },
  kick: { usage: ['/kick (reply) [reason]', '/kick <user id> [reason]'], example: '/kick 123456789 Disturbing members' },
  skick: { usage: ['/skick (reply) [reason]', '/skick <user id> [reason]'], example: '/skick 123456789' },
  dkick: { usage: ['/dkick (reply) [reason]'], example: '/dkick Spam' },
  mute: { usage: ['/mute (reply) [reason]', '/mute <user id> [reason]'], example: '/mute 123456789 Unwanted messages' },
  smute: { usage: ['/smute (reply) [reason]', '/smute <user id> [reason]'], example: '/smute 123456789' },
  tmute: { usage: ['/tmute (reply) <duration> [reason]', '/tmute <user id> <duration> [reason]'], example: '/tmute 123456789 30m Flooding' },
  unmute: { usage: ['/unmute (reply)', '/unmute <user id>'], example: '/unmute 123456789' },
};

const SPEC = {
  ban: { action: 'ban' }, sban: { action: 'ban', silent: true }, tban: { action: 'ban', timed: true },
  unban: { action: 'unban' },
  kick: { action: 'kick' }, skick: { action: 'kick', silent: true }, dkick: { action: 'kick', deleteReplied: true },
  mute: { action: 'mute' }, smute: { action: 'mute', silent: true }, tmute: { action: 'mute', timed: true },
  unmute: { action: 'unmute' },
};

/** Parses "[target] [duration] [reason]". Returns { ok, target, duration, reason } or { ok:false, error }. */
export async function parseModerationArgs(ctx, msg, args, { timed = false, name = 'ban' } = {}) {
  const usage = messages.usage(NAMES[name]?.usage || [`/${name}`], NAMES[name]?.example ? [NAMES[name].example] : [], timed ? DURATION_HELP : 'Reply to a user, or give their numeric user ID.');
  const t = await resolveTarget(ctx, msg, args);
  if (!t.ok) return { ok: false, error: t.error || usage };
  let rest = t.rest;
  let duration = 0;
  if (timed) {
    const m = /^(\S+)([\s\S]*)$/.exec(rest);
    const d = m ? parseDuration(m[1]) : null;
    if (d === null) return { ok: false, error: messages.usage(NAMES[name].usage, [NAMES[name].example], `${DURATION_HELP}\nThe duration must come right after the user.`) };
    if (!durationInRange(d)) return { ok: false, error: messages.warning('Invalid Duration', `${DURATION_HELP} “${m[1]}” is outside that range.`) };
    duration = d;
    rest = m[2].replace(/^\s+/, '');
  }
  return { ok: true, target: t.target, duration, reason: rest.trim().slice(0, 300) || null };
}

async function nameOf(ctx, chatId, target) {
  if (target.user) return userLabel(target.user, target.id);
  try {
    const m = await ctx.tg.getChatMember(chatId, target.id);
    if (m?.user) return userLabel(m.user, target.id);
  } catch { /* unknown to Telegram */ }
  return userLabel(null, target.id);
}

/** Generic handler for all ban / kick / mute style commands. */
async function runModeration(name, ctx, msg, args) {
  const spec = SPEC[name];
  const { chat } = msg;
  const sender = senderOf(msg);
  const group = await getGroup(ctx.db, chat.id);

  const sr = await senderRight(ctx, msg, 'can_restrict_members');
  if (!sr.ok) return reply(ctx, msg, sr.error);
  const problem = await botRightProblem(ctx, chat.id, 'can_restrict_members');
  if (problem) return reply(ctx, msg, problem);

  const parsed = await parseModerationArgs(ctx, msg, args, { timed: spec.timed, name });
  if (!parsed.ok) return reply(ctx, msg, parsed.error);
  const { target, duration, reason } = parsed;

  if (target.id === sender.id) return reply(ctx, msg, messages.warning('Not Allowed', 'You cannot use this command on yourself.'));
  const lifting = spec.action === 'unban' || spec.action === 'unmute';
  const prot = await protectedReason(ctx, chat.id, target.id, { allowAdmins: lifting });
  if (prot) return reply(ctx, msg, messages.warning('Protected User', prot));

  const replied = msg.reply_to_message;
  if (spec.deleteReplied && replied) await tryDelete(ctx, chat.id, replied.message_id);

  const result = await applyRestriction(ctx, chat, group, target.id, spec.action, { duration, reason, moderator: sender.id, messageId: replied?.message_id ?? msg.message_id });
  if (spec.silent || spec.deleteReplied) await tryDelete(ctx, chat.id, msg.message_id);
  if (!result.ok) return reply(ctx, msg, result.error);

  if (spec.silent) return undefined;
  const text = confirmation(spec.action, {
    target: await nameOf(ctx, chat.id, target), targetId: target.id, moderator: userLabel(msg.from, sender.id), reason, chat, duration, expiresAt: result.expiresAt,
  });
  return notify(ctx, msg, text, { extra: { reply_markup: undoButton(spec.action, target.id) } });
}

export const banCommand = (ctx, msg, args) => runModeration('ban', ctx, msg, args);
export const sbanCommand = (ctx, msg, args) => runModeration('sban', ctx, msg, args);
export const tbanCommand = (ctx, msg, args) => runModeration('tban', ctx, msg, args);
export const unbanCommand = (ctx, msg, args) => runModeration('unban', ctx, msg, args);
export const kickCommand = (ctx, msg, args) => runModeration('kick', ctx, msg, args);
export const skickCommand = (ctx, msg, args) => runModeration('skick', ctx, msg, args);
export const dkickCommand = (ctx, msg, args) => runModeration('dkick', ctx, msg, args);
export const muteCommand = (ctx, msg, args) => runModeration('mute', ctx, msg, args);
export const smuteCommand = (ctx, msg, args) => runModeration('smute', ctx, msg, args);
export const tmuteCommand = (ctx, msg, args) => runModeration('tmute', ctx, msg, args);
export const unmuteCommand = (ctx, msg, args) => runModeration('unmute', ctx, msg, args);

// ------------------------------------------------------------------ self-moderation (policy controlled)

async function selfAction(ctx, msg, action, { needsPolicy, duration = 0, label }) {
  const { chat } = msg;
  const sender = senderOf(msg);
  if (!sender) return reply(ctx, msg, messages.denied('I cannot verify anonymous administrators.'));
  const group = await getGroup(ctx.db, chat.id);
  if (needsPolicy) {
    const s = await loadSettings(ctx, group);
    if (!s.bool('selfmod.on')) return reply(ctx, msg, messages.warning('Disabled', `/${label} is turned off in this group. An admin can enable it with /selfmod on.`));
  }
  const problem = await botRightProblem(ctx, chat.id, 'can_restrict_members');
  if (problem) return reply(ctx, msg, problem);
  const prot = await protectedReason(ctx, chat.id, sender.id);
  if (prot) return reply(ctx, msg, messages.warning('Not Allowed', 'Administrators and the group owner cannot use this on themselves.'));
  const result = await applyRestriction(ctx, chat, group, sender.id, action, { duration, reason: 'self-requested', moderator: sender.id, messageId: msg.message_id });
  if (!result.ok) return reply(ctx, msg, result.error);
  return reply(ctx, msg, confirmation(action, { target: userLabel(sender, sender.id), moderator: null, reason: 'Requested by the user', chat, duration, expiresAt: result.expiresAt }));
}

export const kickmeCommand = (ctx, msg) => selfAction(ctx, msg, 'kick', { needsPolicy: false, label: 'kickme' });
export const banmeCommand = (ctx, msg) => selfAction(ctx, msg, 'ban', { needsPolicy: true, label: 'banme' });

export async function mutemeCommand(ctx, msg, args) {
  const token = args.trim().split(/\s+/)[0];
  let duration = 0;
  if (token) {
    duration = parseDuration(token);
    if (duration === null || !durationInRange(duration)) return reply(ctx, msg, messages.usage(['/muteme [duration]'], ['/muteme 2h'], DURATION_HELP));
  }
  return selfAction(ctx, msg, 'mute', { needsPolicy: true, duration, label: 'muteme' });
}

/** Lifts a restriction the user placed on themselves (only those: admin decisions are never overridden). */
async function selfUndo(ctx, msg, kind, action) {
  const { chat } = msg;
  const sender = senderOf(msg);
  if (!sender) return reply(ctx, msg, messages.denied('I cannot verify who you are.'));
  const group = await getGroup(ctx.db, chat.id);
  const rec = await activeRestriction(ctx.db, group, sender.id, kind);
  if (!rec || Number(rec.moderator_id) !== Number(sender.id)) {
    return reply(ctx, msg, messages.warning('Not Self-Imposed', `You have no ${kind} that you placed on yourself. Only an administrator can lift other restrictions.`));
  }
  const problem = await botRightProblem(ctx, chat.id, 'can_restrict_members');
  if (problem) return reply(ctx, msg, problem);
  const result = await applyRestriction(ctx, chat, group, sender.id, action, { reason: 'self-requested', moderator: sender.id, messageId: msg.message_id });
  if (!result.ok) return reply(ctx, msg, result.error);
  return reply(ctx, msg, confirmation(action, { target: userLabel(sender, sender.id), reason: 'Requested by the user', chat }));
}

export const unbanmeCommand = (ctx, msg) => selfUndo(ctx, msg, 'ban', 'unban');
export const unmutemeCommand = (ctx, msg) => selfUndo(ctx, msg, 'mute', 'unmute');

// ------------------------------------------------------------------ callbacks: mod:unban:<id> | mod:unmute:<id> | mod:unwarn:<id>

export async function moderationCallback(ctx, cq, parts) {
  const chat = cq.message?.chat;
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return ctx.tg.answerCallbackQuery(cq.id, 'This button only works in groups.', true);
  const action = parts[1];
  const userId = Number(parts[2]);
  const fake = { chat, from: cq.from, message_id: cq.message.message_id };
  const sr = await senderRight(ctx, fake, 'can_restrict_members');
  if (!sr.ok) return ctx.tg.answerCallbackQuery(cq.id, '🔒 Only admins with the “Ban users” right can use this.', true);
  if (!['unban', 'unmute'].includes(action) || !Number.isSafeInteger(userId)) return ctx.tg.answerCallbackQuery(cq.id, 'Unknown button.', true);
  const group = await getGroup(ctx.db, chat.id);
  const result = await applyRestriction(ctx, chat, group, userId, action, { moderator: cq.from.id, messageId: cq.message.message_id });
  if (!result.ok) return ctx.tg.answerCallbackQuery(cq.id, 'Telegram did not allow that. Check my admin rights.', true);
  await ctx.tg.answerCallbackQuery(cq.id, action === 'unban' ? 'User unbanned.' : 'User unmuted.');
  const text = formatModerationLog({
    emoji: TITLES[action][0],
    titleText: TITLES[action][1],
    fields: [['👤', 'User', userLabel(null, userId)], ['🆔', 'User ID', `<code>${userId}</code>`], ['🛡️', 'Admin', userLabel(cq.from, cq.from.id)]],
    note: NOTES[action],
  });
  await ctx.tg.editMessageText(chat.id, cq.message.message_id, text).catch(() => {});
  return undefined;
}

export { esc };
