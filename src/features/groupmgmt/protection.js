// Antiflood, antispam and anti-raid. All counters live in Turso (group_flood_records) — nothing relies on
import { logModerationLogged } from '../../core/activityLog.js';
// in-memory state, so every Worker instance sees the same numbers.
//
// Honest limits: these are heuristics. They reduce spam and raids; they cannot recognise every spammer.
// Only metadata needed for the checks is stored (user id, counters, a short hash of repeated text) — never message text.

import { getGroup } from '../../database/groups.js';
import { clearGroupCounters, hitCounter, hitGroupCounter, logModeration, resetCounter } from '../../database/groupMod.js';
import { setGroupSetting } from '../../database/settings.js';
import { esc, field, messages } from '../../utils/formatter.js';
import { nowSec, sha256Hex } from '../../utils/helpers.js';
import { reply } from '../../handlers/helpers.js';
import { scheduleDelete } from '../../database/groupMod.js';
import { applyRestriction } from './moderation.js';
import { issueWarning } from './warnings.js';
import { loadSettings } from './settings.js';
import { DURATION_HELP, durationInRange, formatDuration, isExempt, parseDuration, resolveTarget, senderRight, tryDelete, userLabel } from './util.js';
import { boxHtml } from '../../ui/design.js';

export const ACTIONS = ['delete', 'warn', 'mute', 'kick', 'ban'];

/** Applies a configured action to a user (and deletes the offending message). Returns a short outcome string. */
export async function enforce(ctx, chat, group, settings, msg, userId, action, { reason, duration }) {
  if (msg) await tryDelete(ctx, chat.id, msg.message_id);
  if (action === 'delete') return 'deleted';
  if (action === 'warn') {
    const r = await issueWarning(ctx, chat, group, settings, userId, { reason, moderator: null, messageId: msg?.message_id ?? null });
    return `warned (${r.count}/${r.limit})${r.punished ? ` → ${r.action}` : ''}`;
  }
  const res = await applyRestriction(ctx, chat, group, userId, action, { duration: action === 'mute' || action === 'ban' ? duration : 0, reason, moderator: null, messageId: msg?.message_id ?? null });
  return res.ok ? `${action}${duration && action !== 'kick' ? ` (${formatDuration(duration)})` : ''}` : 'failed';
}

async function notice(ctx, chat, text) {
  const sent = await ctx.tg.sendMessage(chat.id, text).catch(() => null);
  if (sent) await scheduleDelete(ctx.db, chat.id, sent.message_id, 30).catch(() => {});
}

// ---------------------------------------------------------------- antiflood
/** Returns true when the message was handled as flood (the caller should stop processing it). */
export async function checkFlood(ctx, msg, group, settings) {
  if (!settings.bool('flood.on') || !msg.from || msg.from.is_bot) return false;
  const limit = settings.int('flood.limit');
  const hits = await hitCounter(ctx.db, group, msg.from.id, 'flood', '', settings.int('flood.window'));
  if (hits <= limit) return false;
  if (await isExempt(ctx, msg.chat.id, msg.from.id)) return false;

  const mode = settings.get('flood.mode');
  const outcome = await enforce(ctx, msg.chat, group, settings, msg, msg.from.id, mode, { reason: `Flooding (${hits} messages in ${settings.int('flood.window')}s)`, duration: settings.int('flood.time') });
  if (mode !== 'delete') await resetCounter(ctx.db, group, msg.from.id, 'flood');
  await logModerationLogged(ctx, group, { action: 'antiflood', target: msg.from.id, reason: `${hits} msgs/${settings.int('flood.window')}s → ${outcome}`, messageId: msg.message_id, result: outcome === 'failed' ? 'failed' : 'success' });
  if (mode !== 'delete' && outcome !== 'failed') await notice(ctx, msg.chat, `${boxHtml("🌊", "FLOOD DETECTED")}\n\n${field('👤', 'User', userLabel(msg.from, msg.from.id), { raw: true })}\n${field('⚡', 'Action', outcome)}`);
  return true;
}

const onOff = (a) => ({ on: true, enable: true, off: false, disable: false })[String(a || '').toLowerCase()];

async function adminGate(ctx, msg) {
  const sr = await senderRight(ctx, msg, null);
  return sr.ok ? null : reply(ctx, msg, sr.error);
}

export async function floodStatus(ctx, msg) {
  const group = await getGroup(ctx.db, msg.chat.id);
  const s = await loadSettings(ctx, group);
  const mode = s.get('flood.mode');
  return reply(ctx, msg, [
    '🌊 <b>Antiflood</b>', '',
    field('📌', 'Status', s.bool('flood.on') ? '✅ Enabled' : '❌ Disabled'),
    field('📊', 'Limit', `${s.int('flood.limit')} messages in ${s.int('flood.window')} seconds`),
    field('⚡', 'Action', mode + (['mute', 'ban'].includes(mode) ? ` (${formatDuration(s.int('flood.time'))})` : '')),
    '', 'Admins are never affected.',
    '<code>/antiflood on|off</code> • <code>/setflood 5 5</code> • <code>/setfloodmode mute 10m</code>',
  ].join('\n'));
}

export async function antifloodCommand(ctx, msg, args) {
  const a = args.trim().toLowerCase();
  if (!a) return floodStatus(ctx, msg);
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const v = onOff(a);
  if (v === undefined) return reply(ctx, msg, messages.usage(['/antiflood [on|off]']));
  const group = await getGroup(ctx.db, msg.chat.id);
  await setGroupSetting(ctx.db, group, 'flood.on', v ? '1' : '0');
  return reply(ctx, msg, `${boxHtml("🌊", "ANTIFLOOD UPDATED")}\n\n${field('📌', 'Status', v ? 'Enabled' : 'Disabled')}`);
}

export const floodCommand = floodStatus;

export async function setfloodCommand(ctx, msg, args) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const group = await getGroup(ctx.db, msg.chat.id);
  const [a, b] = args.trim().toLowerCase().split(/\s+/);
  if (['off', '0'].includes(a)) { await setGroupSetting(ctx.db, group, 'flood.on', '0'); return reply(ctx, msg, `${boxHtml("🌊", "ANTIFLOOD UPDATED")}\n\nAntiflood is now disabled.`); }
  const limit = Number.parseInt(a, 10);
  const window = b === undefined ? null : Number.parseInt(b, 10);
  if (!/^\d+$/.test(a || '') || limit < 2 || limit > 50 || (b !== undefined && (!/^\d+$/.test(b) || window < 2 || window > 60))) {
    return reply(ctx, msg, messages.usage(['/setflood <messages 2-50> [seconds 2-60]', '/setflood off'], ['/setflood 5 5', '/setflood 10 10']));
  }
  await setGroupSetting(ctx.db, group, 'flood.limit', limit);
  if (window !== null) await setGroupSetting(ctx.db, group, 'flood.window', window);
  await setGroupSetting(ctx.db, group, 'flood.on', '1');
  const s = await loadSettings(ctx, group);
  return reply(ctx, msg, `${boxHtml("🌊", "ANTIFLOOD UPDATED")}\n\n${field('📊', 'Limit', `${s.int('flood.limit')} messages in ${s.int('flood.window')} seconds`)}\n${field('📌', 'Status', 'Enabled')}`);
}

export async function floodlimitCommand(ctx, msg, args) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const n = Number.parseInt(args.trim(), 10);
  if (!/^\d+$/.test(args.trim()) || n < 2 || n > 50) return reply(ctx, msg, messages.usage(['/floodlimit <2-50>'], ['/floodlimit 6']));
  const group = await getGroup(ctx.db, msg.chat.id);
  await setGroupSetting(ctx.db, group, 'flood.limit', n);
  return reply(ctx, msg, `${boxHtml("🌊", "FLOOD LIMIT UPDATED")}\n\n${field('📊', 'Limit', `${n} messages`)}`);
}

export async function setfloodmodeCommand(ctx, msg, args) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const [mode, dur] = args.trim().toLowerCase().split(/\s+/);
  if (!ACTIONS.includes(mode)) return reply(ctx, msg, messages.usage(['/setfloodmode <delete|warn|mute|kick|ban> [duration]'], ['/setfloodmode mute 10m'], DURATION_HELP));
  const group = await getGroup(ctx.db, msg.chat.id);
  let sec = null;
  if (dur) {
    sec = parseDuration(dur);
    if (sec === null || !durationInRange(sec)) return reply(ctx, msg, messages.warning('Invalid Duration', DURATION_HELP));
  }
  await setGroupSetting(ctx.db, group, 'flood.mode', mode);
  if (sec !== null) await setGroupSetting(ctx.db, group, 'flood.time', sec);
  return reply(ctx, msg, `${boxHtml("🌊", "FLOOD ACTION UPDATED")}\n\n${field('⚡', 'Action', mode)}${sec ? `\n${field('⏰', 'Duration', formatDuration(sec))}` : ''}`);
}

/** /clearflood [user] — forgets flood counters for one user, or for everybody. */
export async function clearfloodCommand(ctx, msg, args) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const group = await getGroup(ctx.db, msg.chat.id);
  const t = await resolveTarget(ctx, msg, args);
  if (t.ok) { await resetCounter(ctx.db, group, t.target.id, 'flood'); return reply(ctx, msg, messages.success('Flood Counter Cleared', 'That user\'s message count was reset.')); }
  const n = await clearGroupCounters(ctx.db, group, 'flood');
  return reply(ctx, msg, messages.success('Flood Counters Cleared', `${n} counter(s) were reset for this group.`));
}

// ---------------------------------------------------------------- antispam
const normalise = (t) => t.toLowerCase().replace(/\s+/g, ' ').trim();
const urlsIn = (msg) => {
  const text = msg.text ?? msg.caption ?? '';
  const out = [];
  for (const e of msg.entities || msg.caption_entities || []) {
    if (e.type === 'url') out.push(text.slice(e.offset, e.offset + e.length).toLowerCase());
    else if (e.type === 'text_link' && e.url) out.push(e.url.toLowerCase());
  }
  return out;
};

/** Returns a reason string when the message looks like spam, else null. Updates persistent counters. */
export async function detectSpam(ctx, msg, group, settings) {
  const uid = msg.from.id;
  const text = msg.text ?? msg.caption ?? '';
  const mentions = (msg.entities || msg.caption_entities || []).filter((e) => e.type === 'mention' || e.type === 'text_mention').length;
  if (mentions >= settings.int('spam.mentions')) return `excessive mentions (${mentions})`;

  const urls = urlsIn(msg);
  if (urls.length) {
    const key = (await sha256Hex(urls[0])).slice(0, 16);
    if ((await hitCounter(ctx.db, group, uid, 'link', key, 120)) >= settings.int('spam.links')) return 'repeated links';
  }
  if (text.length >= 6) {
    const key = (await sha256Hex(normalise(text))).slice(0, 16);
    if ((await hitCounter(ctx.db, group, uid, 'repeat', key, 60)) >= settings.int('spam.repeat')) return 'repeated identical messages';
  }
  if (msg.forward_origin || msg.forward_date) {
    if ((await hitCounter(ctx.db, group, uid, 'fwd', '', 30)) >= settings.int('spam.forwards')) return 'forwarding burst';
  }
  return null;
}

export async function checkSpam(ctx, msg, group, settings) {
  if (!settings.bool('spam.on') || !msg.from || msg.from.is_bot) return false;
  const reason = await detectSpam(ctx, msg, group, settings);
  if (!reason) return false;
  if (await isExempt(ctx, msg.chat.id, msg.from.id)) return false;
  const mode = settings.get('spam.mode');
  const outcome = await enforce(ctx, msg.chat, group, settings, msg, msg.from.id, mode, { reason: `Spam: ${reason}`, duration: settings.int('spam.time') });
  await logModerationLogged(ctx, group, { action: 'antispam', target: msg.from.id, reason: `${reason} → ${outcome}`, messageId: msg.message_id, result: outcome === 'failed' ? 'failed' : 'success' });
  if (mode !== 'delete' && outcome !== 'failed') await notice(ctx, msg.chat, `${boxHtml("🚫", "SPAM DETECTED")}\n\n${field('👤', 'User', userLabel(msg.from, msg.from.id), { raw: true })}\n${field('🔎', 'Reason', reason)}\n${field('⚡', 'Action', outcome)}`);
  return true;
}

export async function antispamCommand(ctx, msg, args) {
  const group = await getGroup(ctx.db, msg.chat.id);
  const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const s = await loadSettings(ctx, group);
  if (!parts.length) {
    return reply(ctx, msg, [
      '🚫 <b>Anti-Spam</b>', '',
      field('📌', 'Status', s.bool('spam.on') ? '✅ Enabled' : '❌ Disabled'),
      field('⚡', 'Action', s.get('spam.mode') + (['mute', 'ban'].includes(s.get('spam.mode')) ? ` (${formatDuration(s.int('spam.time'))})` : '')),
      field('🔁', 'Identical messages', `${s.int('spam.repeat')} in 60s`),
      field('🔗', 'Same link', `${s.int('spam.links')} in 2 min`),
      field('📣', 'Mentions in one message', s.int('spam.mentions')),
      field('↪️', 'Forwards', `${s.int('spam.forwards')} in 30s`),
      '', 'Admins are never affected. This is a heuristic filter — it cannot catch every spammer.',
      '<code>/antispam on|off</code> • <code>/antispam mode mute 1h</code> • <code>/antispam repeat 4</code>',
    ].join('\n'));
  }
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const [sub, a, b] = parts;
  if (onOff(sub) !== undefined) {
    await setGroupSetting(ctx.db, group, 'spam.on', onOff(sub) ? '1' : '0');
    return reply(ctx, msg, `${boxHtml("🚫", "ANTI-SPAM UPDATED")}\n\n${field('📌', 'Status', onOff(sub) ? 'Enabled' : 'Disabled')}`);
  }
  if (sub === 'mode') {
    if (!ACTIONS.includes(a)) return reply(ctx, msg, messages.usage(['/antispam mode <delete|warn|mute|kick|ban> [duration]'], ['/antispam mode mute 1h']));
    if (b) { const d = parseDuration(b); if (d === null || !durationInRange(d)) return reply(ctx, msg, messages.warning('Invalid Duration', DURATION_HELP)); await setGroupSetting(ctx.db, group, 'spam.time', d); }
    await setGroupSetting(ctx.db, group, 'spam.mode', a);
    return reply(ctx, msg, `${boxHtml("🚫", "ANTI-SPAM ACTION UPDATED")}\n\n${field('⚡', 'Action', a)}`);
  }
  const keys = { repeat: ['spam.repeat', 2, 20], mentions: ['spam.mentions', 2, 50], links: ['spam.links', 2, 20], forwards: ['spam.forwards', 2, 20] };
  if (keys[sub]) {
    const n = Number.parseInt(a, 10);
    const [key, lo, hi] = keys[sub];
    if (!/^\d+$/.test(a || '') || n < lo || n > hi) return reply(ctx, msg, messages.usage([`/antispam ${sub} <${lo}-${hi}>`]));
    await setGroupSetting(ctx.db, group, key, n);
    return reply(ctx, msg, `${boxHtml("🚫", "ANTI-SPAM UPDATED")}\n\n${field('⚙️', sub, n)}`);
  }
  return reply(ctx, msg, messages.usage(['/antispam [on|off]', '/antispam mode <action> [duration]', '/antispam repeat|mentions|links|forwards <n>']));
}

// ---------------------------------------------------------------- anti-raid
export const raidActive = (settings) => settings.int('raid.until') > nowSec();

async function startRaid(ctx, chat, group, settings, why) {
  const until = nowSec() + settings.int('raid.time');
  await setGroupSetting(ctx.db, group, 'raid.until', until);
  await logModerationLogged(ctx, group, { action: 'raid_start', reason: why, expiresAt: until });
  await ctx.tg.sendMessage(chat.id, `${boxHtml("🚨", "RAID PROTECTION ACTIVATED")}\n\n${field('🔎', 'Reason', why)}\n${field('⚡', 'New members will be', settings.get('raid.action') + (settings.get('raid.action') === 'mute' ? ' (muted)' : ''))}\n${field('⏳', 'For', formatDuration(settings.int('raid.time')))}\n\nAdmins: <code>/clearraid</code> ends it early.`).catch(() => {});
  return until;
}

/**
 * Called for every human who joins. Returns true when the raid rules handled the user (kicked / banned / muted),
 * in which case the normal welcome / verification is skipped.
 */
export async function handleRaidJoin(ctx, chat, group, settings, user) {
  let active = raidActive(settings);
  if (!active && settings.bool('raid.on')) {
    const joins = await hitGroupCounter(ctx.db, group, 'join', settings.int('raid.window'));
    if (joins >= settings.int('raid.threshold')) {
      await startRaid(ctx, chat, group, settings, `${joins} members joined within ${settings.int('raid.window')} seconds`);
      active = true;
    }
  }
  if (!active) return false;
  const action = settings.get('raid.action');
  const out = await applyRestriction(ctx, chat, group, user.id, action, { duration: action === 'mute' || action === 'ban' ? settings.int('raid.time') : 0, reason: 'Raid protection', moderator: null });
  await logModerationLogged(ctx, group, { action: 'raid_join', target: user.id, reason: action, result: out.ok ? 'success' : 'failed' });
  return out.ok;
}

export async function antiraidCommand(ctx, msg, args) {
  const group = await getGroup(ctx.db, msg.chat.id);
  const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const s = await loadSettings(ctx, group);
  if (!parts.length) {
    return reply(ctx, msg, [
      '🛡️ <b>Anti-Raid</b>', '',
      field('📌', 'Auto-detection', s.bool('raid.on') ? '✅ Enabled' : '❌ Disabled'),
      field('📊', 'Trigger', `${s.int('raid.threshold')} joins in ${s.int('raid.window')} seconds`),
      field('⚡', 'Action on new members', s.get('raid.action')),
      field('⏳', 'Raid mode lasts', formatDuration(s.int('raid.time'))),
      field('🚨', 'Raid mode now', raidActive(s) ? `ACTIVE until ${new Date(s.int('raid.until') * 1000).toISOString().slice(11, 16)} UTC` : 'inactive'),
      '', '<code>/antiraid on|off</code> • <code>/antiraid 10 60</code> • <code>/raidmode on|off</code> • <code>/raidaction kick|ban|mute</code> • <code>/raidtime 30m</code>',
    ].join('\n'));
  }
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  if (onOff(parts[0]) !== undefined) {
    await setGroupSetting(ctx.db, group, 'raid.on', onOff(parts[0]) ? '1' : '0');
    return reply(ctx, msg, `${boxHtml("🛡️", "ANTI-RAID UPDATED")}\n\n${field('📌', 'Auto-detection', onOff(parts[0]) ? 'Enabled' : 'Disabled')}`);
  }
  const n = Number.parseInt(parts[0], 10);
  const w = parts[1] === undefined ? null : Number.parseInt(parts[1], 10);
  if (!/^\d+$/.test(parts[0]) || n < 3 || n > 200 || (parts[1] !== undefined && (!/^\d+$/.test(parts[1]) || w < 10 || w > 3600))) {
    return reply(ctx, msg, messages.usage(['/antiraid [on|off]', '/antiraid <joins 3-200> [seconds 10-3600]'], ['/antiraid 10 60']));
  }
  await setGroupSetting(ctx.db, group, 'raid.threshold', n);
  if (w !== null) await setGroupSetting(ctx.db, group, 'raid.window', w);
  await setGroupSetting(ctx.db, group, 'raid.on', '1');
  return reply(ctx, msg, `${boxHtml("🛡️", "ANTI-RAID UPDATED")}\n\n${field('📊', 'Trigger', `${n} joins in ${w ?? s.int('raid.window')} seconds`)}\n${field('📌', 'Auto-detection', 'Enabled')}`);
}

/** /raidmode on|off — manually switch the stricter new-member rules on or off. */
export async function raidmodeCommand(ctx, msg, args) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const group = await getGroup(ctx.db, msg.chat.id);
  const s = await loadSettings(ctx, group);
  const v = onOff(args.trim());
  if (v === undefined) return reply(ctx, msg, `${boxHtml("🚨", "Raid Mode")}\n\n${field('📌', 'Status', raidActive(s) ? 'ACTIVE' : 'inactive')}\n\nUse <code>/raidmode on</code> or <code>/raidmode off</code>.`);
  if (v) {
    await startRaid(ctx, msg.chat, group, s, `enabled manually by ${msg.from.first_name || msg.from.id}`);
    return undefined;
  }
  await setGroupSetting(ctx.db, group, 'raid.until', 0);
  await logModerationLogged(ctx, group, { action: 'raid_end', moderator: msg.from.id });
  return reply(ctx, msg, `${boxHtml("✅", "RAID MODE ENDED")}\n\nNew members are no longer restricted.`);
}

export async function raidactionCommand(ctx, msg, args) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const a = args.trim().toLowerCase();
  if (!['kick', 'ban', 'mute'].includes(a)) return reply(ctx, msg, messages.usage(['/raidaction <kick|ban|mute>'], ['/raidaction kick']));
  const group = await getGroup(ctx.db, msg.chat.id);
  await setGroupSetting(ctx.db, group, 'raid.action', a);
  return reply(ctx, msg, `${boxHtml("🛡️", "RAID ACTION UPDATED")}\n\n${field('⚡', 'Action', a)}`);
}

export async function raidtimeCommand(ctx, msg, args) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const d = parseDuration(args.trim());
  if (d === null || d < 60 || d > 7 * 86400) return reply(ctx, msg, messages.usage(['/raidtime <duration>'], ['/raidtime 30m'], 'From 1 minute to 7 days.'));
  const group = await getGroup(ctx.db, msg.chat.id);
  await setGroupSetting(ctx.db, group, 'raid.time', d);
  return reply(ctx, msg, `${boxHtml("🛡️", "RAID TIME UPDATED")}\n\n${field('⏳', 'Raid mode lasts', formatDuration(d))}`);
}

export async function clearraidCommand(ctx, msg) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const group = await getGroup(ctx.db, msg.chat.id);
  await setGroupSetting(ctx.db, group, 'raid.until', 0);
  const n = await clearGroupCounters(ctx.db, group, 'join');
  await logModerationLogged(ctx, group, { action: 'raid_clear', moderator: msg.from.id });
  return reply(ctx, msg, `${boxHtml("✅", "RAID STATE CLEARED")}\n\nRaid mode is off and ${n} join counter(s) were reset.`);
}

export { esc };
