// /afk /unafk  — a member tells the group they are away; anyone who replies to them or taps their mention sees it.
//               Writing a message again clears AFK automatically.
// /approve /unapprove — approved members are exempt from locks, flood, spam, blacklist and captcha checks.

import { getGroup } from '../../database/groups.js';
import { deleteGroupData, getGroupData, setGroupData } from '../../database/settings.js';
import { nowSec } from '../../utils/helpers.js';
import { esc, messages } from '../../utils/formatter.js';
import { formatDateTimeIST } from '../../services/timezone.js';
import { reply } from '../../handlers/helpers.js';
import { formatDuration, resolveTarget, userLabel } from './util.js';
import { box, blockquote, row } from '../../ui/design.js';
import { queueLog, who } from '../../core/activityLog.js';

const AFK = 'afk';
const APPROVED = 'approved';

async function groupOf(ctx, chatId) {
  return (await getGroup(ctx.db, chatId)) || null;
}

export async function isApproved(ctx, chatId, userId) {
  const g = await groupOf(ctx, chatId);
  return Boolean(g && (await getGroupData(ctx.db, g, APPROVED, String(userId))));
}

// ------------------------------------------------------------------ AFK

export async function afkCommand(ctx, msg, args = '') {
  const g = await groupOf(ctx, msg.chat.id);
  if (!g) return reply(ctx, msg, messages.error('Group Not Registered', 'Send any message first, then try again.'));
  const reason = String(args || '').trim().slice(0, 150) || 'no reason given';
  await setGroupData(ctx.db, g, AFK, String(msg.from.id), JSON.stringify({ reason, since: nowSec() }));
  return reply(ctx, msg, `${box('💤', 'You Are AFK')}\n\n${blockquote(`${row('📝', 'Reason', esc(reason))}\n${row('🕒', 'Since', formatDateTimeIST(nowSec()))}`)}\n\n<i>Your AFK status ends when you write again, or with /unafk.</i>`);
}

export async function unafkCommand(ctx, msg) {
  const g = await groupOf(ctx, msg.chat.id);
  if (g) await deleteGroupData(ctx.db, g, AFK, String(msg.from.id));
  return reply(ctx, msg, messages.success('AFK Cleared', 'Welcome back!'));
}

/** Runs on every group message (not commands): clears a returning member's AFK, and tells people who mention an AFK member. */
export async function handleAfkMessage(ctx, msg) {
  const text = String(msg.text ?? msg.caption ?? '');
  if (/^\/(afk|unafk)\b/i.test(text)) return false;
  const g = await groupOf(ctx, msg.chat.id);
  if (!g) return false;

  const sender = msg.from;
  if (sender && !sender.is_bot) {
    const own = await getGroupData(ctx.db, g, AFK, String(sender.id));
    if (own) {
      await deleteGroupData(ctx.db, g, AFK, String(sender.id));
      const away = Math.max(0, nowSec() - Number(JSON.parse(own).since || nowSec()));
      const started = formatDateTimeIST(Number(JSON.parse(own).since));
      await ctx.tg.sendMessage(msg.chat.id, `${box('👋', 'Welcome Back')}\n\n${userLabel(sender, sender.id)} is back.\n${blockquote(`${row('⏱', 'Away for', formatDuration(away) || 'a moment', { raw: false })}\n${row('🕒', 'Went AFK at', started)}`)}`, { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } }).catch(() => {});
    }
  }

  const targets = new Map();
  if (msg.reply_to_message?.from) targets.set(msg.reply_to_message.from.id, msg.reply_to_message.from);
  for (const e of msg.entities || []) if (e.type === 'text_mention' && e.user) targets.set(e.user.id, e.user);
  for (const [id, user] of targets) {
    if (user.is_bot || id === sender?.id) continue;
    const raw = await getGroupData(ctx.db, g, AFK, String(id));
    if (!raw) continue;
    const { reason, since } = JSON.parse(raw);
    await ctx.tg.sendMessage(msg.chat.id, `${box('💤', 'Currently AFK')}\n\n${userLabel(user, id)} is away.\n${blockquote(`${row('📝', 'Reason', esc(reason))}\n${row('🕒', 'Since', formatDateTimeIST(Number(since)))}`)}`, { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } }).catch(() => {});
    return false;
  }
  return false;
}

// ------------------------------------------------------------------ approve

export async function approveCommand(ctx, msg, args) {
  const t = await resolveTarget(ctx, msg, args);
  if (!t.ok) return reply(ctx, msg, t.error || messages.usage(['/approve (reply)', '/approve [user id]'], ['/approve 123456789']));
  const g = await groupOf(ctx, msg.chat.id);
  if (!g) return reply(ctx, msg, messages.error('Group Not Registered', 'Send any message first, then try again.'));
  await setGroupData(ctx.db, g, APPROVED, String(t.target.id), String(nowSec()));
  queueLog(ctx, `✅ <b>approved</b> <code>${t.target.id}</code> in ${esc(msg.chat.title || String(msg.chat.id))} · by ${who(msg.from)}`);
  return reply(ctx, msg, `${box('✅', 'Member Approved')}\n\n${blockquote(`${row('👤', 'Member', userLabel(t.target.user, t.target.id), { raw: true })}\n${row('🛡', 'Exempt from', 'locks, flood, spam, blacklist, captcha')}`)}`);
}

export async function unapproveCommand(ctx, msg, args) {
  const t = await resolveTarget(ctx, msg, args);
  if (!t.ok) return reply(ctx, msg, t.error || messages.usage(['/unapprove (reply)', '/unapprove [user id]'], ['/unapprove 123456789']));
  const g = await groupOf(ctx, msg.chat.id);
  if (!g) return reply(ctx, msg, messages.error('Group Not Registered', 'Send any message first, then try again.'));
  if (!(await getGroupData(ctx.db, g, APPROVED, String(t.target.id)))) return reply(ctx, msg, messages.warning('Not Approved', 'That member is not on the approved list.'));
  await deleteGroupData(ctx.db, g, APPROVED, String(t.target.id));
  queueLog(ctx, `↩️ <b>unapproved</b> <code>${t.target.id}</code> in ${esc(msg.chat.title || String(msg.chat.id))} · by ${who(msg.from)}`);
  return reply(ctx, msg, messages.success('Approval Removed', 'That member is subject to the group rules again.'));
}
