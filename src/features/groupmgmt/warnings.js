// Warning system: /warn /dwarn /swarn /unwarn /rmwarn /resetwarn /warns /warnings /warnlimit /warnmode /warntime.
import { logModerationLogged } from '../../core/activityLog.js';
// Warnings are stored per group; reaching the limit applies the configured action and clears that user's warnings.

import { getGroup } from '../../database/groups.js';
import { addWarning, countWarnings, listWarnings, logModeration, removeLastWarning, removeWarningById, resetWarnings } from '../../database/groupMod.js';
import { setGroupSetting } from '../../database/settings.js';
import { senderOf } from '../../core/permissions.js';
import { esc, field, messages } from '../../utils/formatter.js';
import { formatModerationLog } from '../../ui/design.js';
import { btn, markup } from '../../keyboards/inlineKeyboard.js';
import { nowSec } from '../../utils/helpers.js';
import { reply } from '../../handlers/helpers.js';
import { formatDateTimeIST } from '../../services/timezone.js';
import { applyRestriction, parseModerationArgs } from './moderation.js';
import { loadSettings } from './settings.js';
import { DURATION_HELP, durationInRange, formatDuration, notify, parseDuration, protectedReason, resolveTarget, senderRight, tgFailure, tryDelete, userLabel } from './util.js';
import { boxHtml } from '../../ui/design.js';

const MODES = ['ban', 'mute', 'kick', 'none'];
const MODE_LABEL = { ban: '🔨 Ban', mute: '🔇 Mute', kick: '👢 Kick', none: '➖ No automatic punishment' };

/**
 * Issues one warning and applies the punishment when the limit is reached.
 * Used by /warn and by antiflood / antispam / blacklist. Returns { count, limit, punished, action, error }.
 */
export async function issueWarning(ctx, chat, group, settings, userId, { reason, moderator, messageId = null }) {
  const warnTime = settings.int('warn.time');
  await addWarning(ctx.db, group, { userId, moderator, reason, expiresAt: warnTime ? nowSec() + warnTime : null });
  await logModerationLogged(ctx, group, { action: 'warn', target: userId, moderator, reason, messageId }).catch(() => {});
  const count = await countWarnings(ctx.db, group, userId);
  const limit = settings.int('warn.limit');
  const out = { count, limit, punished: false, action: null, error: null };
  if (count < limit) return out;

  const mode = settings.get('warn.mode');
  if (!MODES.includes(mode) || mode === 'none') return out;
  const duration = settings.int('warn.mode_time');
  const res = await applyRestriction(ctx, chat, group, userId, mode, { duration, reason: `Warning limit reached (${count}/${limit})`, moderator, messageId });
  if (res.ok) {
    await resetWarnings(ctx.db, group, userId);
    return { ...out, punished: true, action: mode, duration };
  }
  return { ...out, action: mode, error: res.error };
}

function warnPanel({ title, emoji, target, targetId, moderator, count, limit, reason, outcome }) {
  let note = '';
  if (outcome?.punished) note = `Limit reached — ${MODE_LABEL[outcome.action]} applied${outcome.duration ? ` for ${formatDuration(outcome.duration)}` : ''}. Warnings were reset.`;
  else if (outcome && !outcome.error && outcome.count >= outcome.limit) note = 'Limit reached — no automatic punishment is configured (/warnmode).';
  let text = formatModerationLog({
    emoji,
    titleText: title,
    fields: [
      ['👤', 'User', target],
      targetId ? ['🆔', 'User ID', `<code>${esc(targetId)}</code>`] : null,
      moderator ? ['🛡️', 'Admin', moderator] : null,
      count !== undefined ? ['📊', 'Warnings', esc(`${count}/${limit}`)] : null,
      reason ? ['📝', 'Reason', esc(reason)] : null,
      ['🕒', 'Time', esc(formatDateTimeIST(nowSec()))],
    ],
    note,
  });
  if (outcome?.error) text += `\n\n🚨 <b>Limit reached</b>, but the punishment failed:\n${outcome.error}`;
  return text;
}

async function runWarn(name, ctx, msg, args) {
  const { chat } = msg;
  const sender = senderOf(msg);
  const group = await getGroup(ctx.db, chat.id);
  const sr = await senderRight(ctx, msg, 'can_restrict_members');
  if (!sr.ok) return reply(ctx, msg, sr.error);

  const usage = { warn: ['/warn (reply) [reason]', '/warn <user id> [reason]'], dwarn: ['/dwarn (reply) [reason]'], swarn: ['/swarn (reply) [reason]', '/swarn <user id> [reason]'] }[name];
  const parsed = await parseModerationArgs(ctx, msg, args, { name: 'warn' });
  if (!parsed.ok) return reply(ctx, msg, parsed.error || messages.usage(usage, [`/${name} Repeated links`]));
  const { target, reason } = parsed;
  if (name === 'dwarn' && !msg.reply_to_message) return reply(ctx, msg, messages.usage(usage, ['/dwarn Unwanted links'], 'Reply to the message you want deleted.'));

  if (target.id === sender.id) return reply(ctx, msg, messages.warning('Not Allowed', 'You cannot warn yourself.'));
  const prot = await protectedReason(ctx, chat.id, target.id);
  if (prot) return reply(ctx, msg, messages.warning('Protected User', prot));

  const settings = await loadSettings(ctx, group);
  // Escalating to a punishment needs the bot's rights; check first so we never record a warning we cannot act on.
  const replied = msg.reply_to_message;
  if (name === 'dwarn' && replied) await tryDelete(ctx, chat.id, replied.message_id);
  const outcome = await issueWarning(ctx, chat, group, settings, target.id, { reason, moderator: sender.id, messageId: replied?.message_id ?? msg.message_id });

  if (name === 'swarn') { await tryDelete(ctx, chat.id, msg.message_id); if (!outcome.error) return undefined; }
  const label = target.user ? userLabel(target.user, target.id) : userLabel(null, target.id);
  return notify(ctx, msg, warnPanel({ title: 'WARNING ISSUED', emoji: '⚠️', target: label, targetId: target.id, moderator: userLabel(msg.from, sender.id), count: outcome.count, limit: outcome.limit, reason, outcome }), {
    extra: { reply_markup: outcome.punished ? undefined : markup([[btn('↩️ Undo Warning', `wn:rm:${target.id}`)]]) },
  });
}

export const warnCommand = (ctx, msg, args) => runWarn('warn', ctx, msg, args);
export const dwarnCommand = (ctx, msg, args) => runWarn('dwarn', ctx, msg, args);
export const swarnCommand = (ctx, msg, args) => runWarn('swarn', ctx, msg, args);

async function targetOnly(ctx, msg, args, usage) {
  const t = await resolveTarget(ctx, msg, args);
  if (!t.ok) return { error: t.error || messages.usage(usage) };
  return { target: t.target, rest: t.rest };
}

export async function unwarnCommand(ctx, msg, args) {
  const sr = await senderRight(ctx, msg, 'can_restrict_members');
  if (!sr.ok) return reply(ctx, msg, sr.error);
  const group = await getGroup(ctx.db, msg.chat.id);
  const t = await targetOnly(ctx, msg, args, ['/unwarn (reply)', '/unwarn <user id>']);
  if (t.error) return reply(ctx, msg, t.error);
  const removed = await removeLastWarning(ctx.db, group, t.target.id);
  if (!removed) return reply(ctx, msg, messages.warning('No Warnings', 'That user has no active warnings.'));
  await logModerationLogged(ctx, group, { action: 'unwarn', target: t.target.id, moderator: msg.from.id });
  const settings = await loadSettings(ctx, group);
  const count = await countWarnings(ctx.db, group, t.target.id);
  return reply(ctx, msg, warnPanel({ title: 'WARNING REMOVED', emoji: '✅', target: userLabel(t.target.user, t.target.id), targetId: t.target.id, moderator: userLabel(msg.from, msg.from.id), count, limit: settings.int('warn.limit') }));
}

/** /rmwarn <warn id> — remove one specific warning (ids are shown by /warns). */
export async function rmwarnCommand(ctx, msg, args) {
  const sr = await senderRight(ctx, msg, 'can_restrict_members');
  if (!sr.ok) return reply(ctx, msg, sr.error);
  const group = await getGroup(ctx.db, msg.chat.id);
  const id = Number.parseInt(args.trim().replace(/^#/, ''), 10);
  if (!Number.isInteger(id) || id < 1) return reply(ctx, msg, messages.usage(['/rmwarn <warning id>'], ['/rmwarn 12'], 'Warning ids are listed by /warns.'));
  const row = await ctx.db.first('SELECT user_id FROM group_warnings WHERE id = ? AND group_id = ?', [id, group.id]);
  if (!row || !(await removeWarningById(ctx.db, group, id))) return reply(ctx, msg, messages.warning('Not Found', `There is no warning #${id} in this group.`));
  await logModerationLogged(ctx, group, { action: 'rmwarn', target: row.user_id, moderator: msg.from.id, reason: `warning #${id}` });
  return reply(ctx, msg, messages.success('Warning Removed', `Warning #${id} was deleted.`));
}

export async function resetwarnCommand(ctx, msg, args) {
  const sr = await senderRight(ctx, msg, 'can_restrict_members');
  if (!sr.ok) return reply(ctx, msg, sr.error);
  const group = await getGroup(ctx.db, msg.chat.id);
  const t = await targetOnly(ctx, msg, args, ['/resetwarn (reply)', '/resetwarn <user id>']);
  if (t.error) return reply(ctx, msg, t.error);
  const n = await resetWarnings(ctx.db, group, t.target.id);
  await logModerationLogged(ctx, group, { action: 'resetwarn', target: t.target.id, moderator: msg.from.id, reason: `${n} warning(s) cleared` });
  return reply(ctx, msg, `${boxHtml("✅", "WARNINGS RESET")}\n\n${field('👤', 'User', userLabel(t.target.user, t.target.id), { raw: true })}\n${field('🧹', 'Cleared', n)}`);
}

/** /warns [user] — anyone may check their own; admins can check others. */
export async function warnsCommand(ctx, msg, args) {
  const group = await getGroup(ctx.db, msg.chat.id);
  const sender = senderOf(msg);
  const t = await resolveTarget(ctx, msg, args);
  let target = sender ? { id: sender.id, user: msg.from } : null;
  if (t.ok) {
    if (sender && t.target.id !== sender.id) {
      const sr = await senderRight(ctx, msg, null);
      if (!sr.ok) return reply(ctx, msg, messages.denied('You can only look at your own warnings.'));
    }
    target = t.target;
  } else if (t.error) return reply(ctx, msg, t.error);
  if (!target) return reply(ctx, msg, messages.denied('I cannot verify who you are.'));

  const settings = await loadSettings(ctx, group);
  const rows = await listWarnings(ctx.db, group, target.id);
  const limit = settings.int('warn.limit');
  if (!rows.length) return reply(ctx, msg, `${boxHtml("✅", "No Warnings")}\n\n${field('👤', 'User', userLabel(target.user, target.id), { raw: true })}\n${field('📊', 'Warnings', `0/${limit}`)}`);
  const list = rows.map((w, i) => `${i + 1}. <code>#${w.id}</code> ${w.reason ? `— ${esc(w.reason)}` : '— <i>no reason</i>'} <i>(${formatDateTimeIST(w.created_at)})</i>`).join('\n');
  return reply(ctx, msg, `${boxHtml("⚠️", "WARNINGS")}\n\n${field('👤', 'User', userLabel(target.user, target.id), { raw: true })}\n${field('📊', 'Warnings', `${rows.length}/${limit}`)}\n\n${list}`);
}

// ---------------------------------------------------------------- configuration
async function adminOnly(ctx, msg) {
  const sr = await senderRight(ctx, msg, null);
  return sr.ok ? null : reply(ctx, msg, sr.error);
}

export async function warnlimitCommand(ctx, msg, args) {
  const deny = await adminOnly(ctx, msg); if (deny) return deny;
  const group = await getGroup(ctx.db, msg.chat.id);
  const arg = args.trim();
  if (!arg) return reply(ctx, msg, `${boxHtml("⚙️", "Warning Limit")}\n\n${field('📊', 'Current limit', (await loadSettings(ctx, group)).int('warn.limit'))}\n\nChange it with <code>/warnlimit &lt;1-100&gt;</code>.`);
  const n = Number.parseInt(arg, 10);
  if (!/^\d{1,3}$/.test(arg) || n < 1 || n > 100) return reply(ctx, msg, messages.usage(['/warnlimit <number 1-100>'], ['/warnlimit 3']));
  await setGroupSetting(ctx.db, group, 'warn.limit', n);
  return reply(ctx, msg, `${boxHtml("✅", "WARNING LIMIT UPDATED")}\n\n${field('📊', 'New limit', n)}`);
}

export async function warnmodeCommand(ctx, msg, args) {
  const deny = await adminOnly(ctx, msg); if (deny) return deny;
  const group = await getGroup(ctx.db, msg.chat.id);
  const [mode, durToken] = args.trim().toLowerCase().split(/\s+/);
  if (!mode) {
    const s = await loadSettings(ctx, group);
    return reply(ctx, msg, `${boxHtml("⚙️", "Warning Action")}\n\n${field('⚡', 'When the limit is reached', MODE_LABEL[s.get('warn.mode')] || s.get('warn.mode'))}\n\nChange: <code>/warnmode ban|mute|kick|none</code> (mute/ban accept a duration, e.g. <code>/warnmode mute 1d</code>).`);
  }
  if (!MODES.includes(mode)) return reply(ctx, msg, messages.usage(['/warnmode <ban|mute|kick|none> [duration]'], ['/warnmode mute 1d'], DURATION_HELP));
  let duration = 0;
  if (durToken) {
    if (!['ban', 'mute'].includes(mode)) return reply(ctx, msg, messages.warning('Duration Not Applicable', 'Only ban and mute accept a duration.'));
    duration = parseDuration(durToken);
    if (duration === null || !durationInRange(duration)) return reply(ctx, msg, messages.warning('Invalid Duration', DURATION_HELP));
  }
  await setGroupSetting(ctx.db, group, 'warn.mode', mode);
  await setGroupSetting(ctx.db, group, 'warn.mode_time', duration);
  return reply(ctx, msg, `${boxHtml("✅", "WARNING ACTION UPDATED")}\n\n${field('⚡', 'Action', MODE_LABEL[mode])}${duration ? `\n${field('⏰', 'Duration', formatDuration(duration))}` : ''}`);
}

export async function warntimeCommand(ctx, msg, args) {
  const deny = await adminOnly(ctx, msg); if (deny) return deny;
  const group = await getGroup(ctx.db, msg.chat.id);
  const arg = args.trim().toLowerCase();
  if (!arg) {
    const t = (await loadSettings(ctx, group)).int('warn.time');
    return reply(ctx, msg, `${boxHtml("⚙️", "Warning Expiry")}\n\n${field('⏳', 'Warnings expire after', t ? formatDuration(t) : 'never')}\n\nChange: <code>/warntime 7d</code> — or <code>/warntime off</code>.`);
  }
  let sec = 0;
  if (!['off', '0', 'never'].includes(arg)) {
    sec = parseDuration(arg);
    if (sec === null || sec < 60 || sec > 366 * 86400) return reply(ctx, msg, messages.usage(['/warntime <duration|off>'], ['/warntime 7d'], 'From 1 minute to 366 days. Applies to NEW warnings.'));
  }
  await setGroupSetting(ctx.db, group, 'warn.time', sec);
  return reply(ctx, msg, `${boxHtml("✅", "WARNING EXPIRY UPDATED")}\n\n${field('⏳', 'New warnings expire after', sec ? formatDuration(sec) : 'never')}`);
}

/** Callback wn:rm:<userId> — remove one warning from the warning notice. */
export async function warningCallback(ctx, cq, parts) {
  const chat = cq.message?.chat;
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return ctx.tg.answerCallbackQuery(cq.id, 'Groups only.', true);
  const sr = await senderRight(ctx, { chat, from: cq.from }, 'can_restrict_members');
  if (!sr.ok) return ctx.tg.answerCallbackQuery(cq.id, '🔒 Only admins can remove warnings.', true);
  const group = await getGroup(ctx.db, chat.id);
  const userId = Number(parts[2]);
  if (parts[1] !== 'rm' || !Number.isSafeInteger(userId)) return ctx.tg.answerCallbackQuery(cq.id, 'Unknown button.', true);
  const removed = await removeLastWarning(ctx.db, group, userId);
  if (!removed) return ctx.tg.answerCallbackQuery(cq.id, 'No active warnings left.', true);
  await logModerationLogged(ctx, group, { action: 'unwarn', target: userId, moderator: cq.from.id });
  const count = await countWarnings(ctx.db, group, userId);
  await ctx.tg.answerCallbackQuery(cq.id, `Warning removed (${count} left).`);
  await ctx.tg.editMessageText(chat.id, cq.message.message_id, `${boxHtml("✅", "WARNING REMOVED")}\n\n${field('👤', 'User', userLabel(null, userId), { raw: true })}\n${field('🛡️', 'Moderator', userLabel(cq.from, cq.from.id), { raw: true })}\n${field('📊', 'Remaining', count)}`).catch(() => {});
  return undefined;
}

export { tgFailure };
