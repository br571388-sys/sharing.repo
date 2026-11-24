// New-member verification. Unverified members are muted (native Telegram restriction) until they press the right
import { logModerationLogged } from '../../core/activityLog.js';
// button; if they do not verify in time the configured action runs (decided by the 1-minute cron).
// Commands: /captcha /verify /setcaptcha /captchamode /captchatime /captchakick.

import { getGroup } from '../../database/groups.js';
import { dueVerifications, getVerification, logModeration, settleVerification, startVerification } from '../../database/groupMod.js';
import { setGroupSetting } from '../../database/settings.js';
import { btn, markup } from '../../keyboards/inlineKeyboard.js';
import { esc, field, messages } from '../../utils/formatter.js';
import { nowSec } from '../../utils/helpers.js';
import { reply } from '../../handlers/helpers.js';
import { MUTED, applyRestriction } from './moderation.js';
import { loadSettings } from './settings.js';
import { applyPlaceholders } from './content.js';
import { botRightProblem, formatDuration, parseDuration, resolveTarget, senderRight, tryDelete, userLabel } from './util.js';
import { welcomeNewMember } from './greetings.js';
import { boxHtml } from '../../ui/design.js';

const randInt = (n) => Math.floor(Math.random() * n);

function buildChallenge(mode, userId) {
  if (mode === 'math') {
    const a = 2 + randInt(8); const b = 2 + randInt(8);
    const answer = a + b;
    const options = new Set([answer]);
    while (options.size < 4) options.add(Math.max(1, answer + randInt(9) - 4));
    const shuffled = [...options].sort(() => Math.random() - 0.5);
    return {
      question: `🧮 What is <b>${a} + ${b}</b>?`, answer: String(answer),
      buttons: [shuffled.map((o) => btn(String(o), `vf:${userId}:${o}`))],
    };
  }
  return { question: '👇 Press the button below to prove you are human.', answer: 'ok', buttons: [[btn('✅ I am human', `vf:${userId}:ok`)]] };
}

/** Restricts a newcomer and posts the challenge. Returns true when verification is now pending. */
export async function beginVerification(ctx, chat, group, settings, user) {
  const problem = await botRightProblem(ctx, chat.id, 'can_restrict_members');
  if (problem) {
    await logModerationLogged(ctx, group, { action: 'captcha_skipped', target: user.id, reason: 'bot lacks restrict right', result: 'failed' }).catch(() => {});
    return false;
  }
  try {
    await ctx.tg.restrictChatMember(chat.id, user.id, MUTED);
  } catch (e) {
    await logModerationLogged(ctx, group, { action: 'captcha_skipped', target: user.id, reason: String(e?.message).slice(0, 100), result: 'failed' }).catch(() => {});
    return false;
  }
  const challenge = buildChallenge(settings.get('captcha.mode'), user.id);
  const time = settings.int('captcha.time');
  const custom = settings.get('captcha.text');
  const intro = custom ? applyPlaceholders(custom, { user, chat }) : `👋 <b>Welcome ${userLabel(user, user.id)}!</b>`;
  let sent = null;
  try {
    sent = await ctx.tg.sendMessage(chat.id, `${intro}\n\n${challenge.question}\n\n⏳ You have <b>${formatDuration(time)}</b>. Until then you cannot send messages.`, { reply_markup: markup(challenge.buttons) });
  } catch { /* no message: the user stays muted and the cron will resolve it */ }
  await startVerification(ctx.db, group, { userId: user.id, messageId: sent?.message_id ?? null, answer: challenge.answer, expiresAt: nowSec() + time });
  await logModerationLogged(ctx, group, { action: 'captcha_start', target: user.id, expiresAt: nowSec() + time });
  return true;
}

async function unrestrict(ctx, chat, group, userId, moderator = null) {
  return applyRestriction(ctx, chat, group, userId, 'unmute', { reason: 'verified', moderator });
}

/** vf:<userId>:<answer> — only the new member can press it. */
export async function verifyCallback(ctx, cq, parts) {
  const chat = cq.message?.chat;
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return ctx.tg.answerCallbackQuery(cq.id, 'Groups only.', true);
  const userId = Number(parts[1]);
  if (!Number.isSafeInteger(userId)) return ctx.tg.answerCallbackQuery(cq.id, 'Unknown button.', true);
  if (cq.from.id !== userId) return ctx.tg.answerCallbackQuery(cq.id, '🔒 This button is not for you.', true);

  const group = await getGroup(ctx.db, chat.id);
  const v = await getVerification(ctx.db, group, userId);
  if (!v || v.status !== 'pending') return ctx.tg.answerCallbackQuery(cq.id, 'This verification is no longer active.', true);
  if (String(parts[2]) !== String(v.answer)) return ctx.tg.answerCallbackQuery(cq.id, '❌ Wrong answer — try again.', true);

  if (!(await settleVerification(ctx.db, group, userId, 'verified'))) return ctx.tg.answerCallbackQuery(cq.id, 'Already verified.');
  const res = await unrestrict(ctx, chat, group, userId);
  if (!res.ok) {
    await ctx.tg.answerCallbackQuery(cq.id, 'Verified, but I could not lift your restriction. Please ask an admin.', true);
    return undefined;
  }
  await ctx.tg.answerCallbackQuery(cq.id, '✅ Verified! Welcome.');
  await logModerationLogged(ctx, group, { action: 'captcha_verified', target: userId });
  await tryDelete(ctx, chat.id, cq.message.message_id);
  const settings = await loadSettings(ctx, group);
  await welcomeNewMember(ctx, chat, group, settings, cq.from);
  return undefined;
}

/** Cron: resolve verifications whose time ran out. */
export async function expireVerifications(ctx, now = nowSec()) {
  let handled = 0;
  for (const v of await dueVerifications(ctx.db, now)) {
    const group = await ctx.db.first('SELECT * FROM groups WHERE id = ?', [v.group_id]);
    if (!group) continue;
    if (!(await settleVerification(ctx.db, group, v.user_id, 'expired'))) continue; // another run took it
    const chat = { id: v.telegram_chat_id, title: group.title };
    const settings = await loadSettings(ctx, group);
    const action = settings.get('captcha.action');
    if (action !== 'mute') await applyRestriction(ctx, chat, group, v.user_id, action, { reason: 'Did not complete verification', moderator: null });
    else await logModerationLogged(ctx, group, { action: 'captcha_expired', target: v.user_id, reason: 'left muted' });
    if (v.message_id) await tryDelete(ctx, chat.id, v.message_id);
    handled++;
  }
  return handled;
}

// ---------------------------------------------------------------- commands
const onOff = (a) => ({ on: true, enable: true, off: false, disable: false })[String(a || '').toLowerCase()];
async function adminGate(ctx, msg) {
  const sr = await senderRight(ctx, msg, null);
  return sr.ok ? null : reply(ctx, msg, sr.error);
}

export async function captchaCommand(ctx, msg, args) {
  const group = await getGroup(ctx.db, msg.chat.id);
  const s = await loadSettings(ctx, group);
  const a = args.trim();
  if (!a) {
    return reply(ctx, msg, [
      '🧩 <b>New Member Verification</b>', '',
      field('📌', 'Status', s.bool('captcha.on') ? '✅ Enabled' : '❌ Disabled'),
      field('🎛️', 'Mode', s.get('captcha.mode')),
      field('⏳', 'Time to verify', formatDuration(s.int('captcha.time'))),
      field('⚡', 'If they do not verify', s.get('captcha.action')),
      '', '<code>/captcha on|off</code> • <code>/captchamode button|math</code> • <code>/captchatime 5m</code> • <code>/captchakick kick|ban|mute</code> • <code>/setcaptcha &lt;text&gt;</code>',
    ].join('\n'));
  }
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const v = onOff(a);
  if (v === undefined) return reply(ctx, msg, messages.usage(['/captcha [on|off]']));
  if (v) {
    const problem = await botRightProblem(ctx, msg.chat.id, 'can_restrict_members');
    if (problem) return reply(ctx, msg, problem);
  }
  await setGroupSetting(ctx.db, group, 'captcha.on', v ? '1' : '0');
  return reply(ctx, msg, `${boxHtml("🧩", "VERIFICATION UPDATED")}\n\n${field('📌', 'Status', v ? 'Enabled' : 'Disabled')}`);
}

export async function setcaptchaCommand(ctx, msg, args, cmd) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const group = await getGroup(ctx.db, msg.chat.id);
  const text = (msg.text || '').slice(cmd.argsStart).trim();
  if (!text) {
    await setGroupSetting(ctx.db, group, 'captcha.text', '');
    return reply(ctx, msg, messages.usage(['/setcaptcha <welcome text shown above the challenge>'], ['/setcaptcha Hi {first}, please verify to join {chatname}!'], 'Plain text (placeholders: {first} {mention} {chatname}). Sending it empty restored the default.'));
  }
  if (text.length > 400) return reply(ctx, msg, messages.warning('Text Too Long', 'Verification text can have at most 400 characters.'));
  await setGroupSetting(ctx.db, group, 'captcha.text', esc(text));
  return reply(ctx, msg, `${boxHtml("🧩", "VERIFICATION TEXT UPDATED")}\n\n${field('📝', 'Text', text)}`);
}

export async function captchamodeCommand(ctx, msg, args) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const m = args.trim().toLowerCase();
  if (!['button', 'math'].includes(m)) return reply(ctx, msg, messages.usage(['/captchamode <button|math>'], ['/captchamode math'], '“button” = one tap; “math” = pick the right answer of a small sum.'));
  const group = await getGroup(ctx.db, msg.chat.id);
  await setGroupSetting(ctx.db, group, 'captcha.mode', m);
  return reply(ctx, msg, `${boxHtml("🧩", "VERIFICATION MODE UPDATED")}\n\n${field('🎛️', 'Mode', m)}`);
}

export async function captchatimeCommand(ctx, msg, args) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const d = parseDuration(args.trim());
  if (d === null || d < 60 || d > 86400) return reply(ctx, msg, messages.usage(['/captchatime <duration>'], ['/captchatime 5m'], 'From 1 minute to 1 day. Expiry is checked every minute.'));
  const group = await getGroup(ctx.db, msg.chat.id);
  await setGroupSetting(ctx.db, group, 'captcha.time', d);
  return reply(ctx, msg, `${boxHtml("🧩", "VERIFICATION TIME UPDATED")}\n\n${field('⏳', 'Time to verify', formatDuration(d))}`);
}

export async function captchakickCommand(ctx, msg, args) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const a = args.trim().toLowerCase();
  if (!['kick', 'ban', 'mute'].includes(a)) return reply(ctx, msg, messages.usage(['/captchakick <kick|ban|mute>'], ['/captchakick kick'], 'What happens to members who do not verify in time. “mute” leaves them muted.'));
  const group = await getGroup(ctx.db, msg.chat.id);
  await setGroupSetting(ctx.db, group, 'captcha.action', a);
  return reply(ctx, msg, `${boxHtml("🧩", "EXPIRY ACTION UPDATED")}\n\n${field('⚡', 'Action', a)}`);
}

/**
 * /verify — an admin replying to (or naming) a muted newcomer approves them manually;
 * a pending member can run it to get their verification message again.
 */
export async function verifyCommand(ctx, msg, args) {
  const group = await getGroup(ctx.db, msg.chat.id);
  const settings = await loadSettings(ctx, group);
  const t = await resolveTarget(ctx, msg, args);
  const isAdmin = (await senderRight(ctx, msg, 'can_restrict_members')).ok;

  if (t.ok && t.target.id !== msg.from.id) {
    if (!isAdmin) return reply(ctx, msg, messages.denied('Only admins can verify other members.'));
    await settleVerification(ctx.db, group, t.target.id, 'verified');
    const res = await unrestrict(ctx, msg.chat, group, t.target.id, msg.from.id);
    if (!res.ok) return reply(ctx, msg, res.error);
    const v = await getVerification(ctx.db, group, t.target.id);
    if (v?.message_id) await tryDelete(ctx, msg.chat.id, v.message_id);
    await logModerationLogged(ctx, group, { action: 'verify', target: t.target.id, moderator: msg.from.id });
    return reply(ctx, msg, `${boxHtml("✅", "MEMBER VERIFIED")}\n\n${field('👤', 'User', userLabel(t.target.user, t.target.id), { raw: true })}\n${field('🛡️', 'By', userLabel(msg.from, msg.from.id), { raw: true })}`);
  }
  const v = await getVerification(ctx.db, group, msg.from.id);
  if (v?.status === 'pending') {
    const challenge = buildChallenge(settings.get('captcha.mode'), msg.from.id);
    await startVerification(ctx.db, group, { userId: msg.from.id, messageId: v.message_id, answer: challenge.answer, expiresAt: v.expires_at });
    return reply(ctx, msg, `${challenge.question}`, { reply_markup: markup(challenge.buttons) });
  }
  return reply(ctx, msg, settings.bool('captcha.on')
    ? messages.success('Nothing to Verify', 'You are not waiting for verification. (Admins: reply to a member with /verify to approve them.)')
    : messages.warning('Verification Is Off', 'This group does not use verification. Admins can enable it with /captcha on.'));
}
