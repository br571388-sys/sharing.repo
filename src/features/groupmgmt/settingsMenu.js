// /settings (/config /groupconfig): inline-keyboard control panel. Every button is checked against the REAL Telegram
// admin status of whoever pressed it; the menu only ever reads and writes the group of the chat it was opened in.

import { getGroup } from '../../database/groups.js';
import { countBlacklist, countFilters, listNotes } from '../../database/groupMod.js';
import { setGroupSetting } from '../../database/settings.js';
import { btn, markup } from '../../keyboards/inlineKeyboard.js';
import { SEP, esc, field } from '../../utils/formatter.js';
import { reply } from '../../handlers/helpers.js';
import { LOCK_TYPES, applyLocks } from './locks.js';
import { getRules } from './rules.js';
import { loadSettings } from './settings.js';
import { botRightProblem, formatDuration, senderRight } from './util.js';
import { getGreeting } from '../../database/groupMod.js';
import { boxHtml, onOff } from '../../ui/design.js';

const YN = onOff; // 🟢 ON / 🔴 OFF — always a real stored value
const SECTIONS = [
  ['sec', '🛡️ Security'], ['mod', '🔨 Moderation'], ['locks', '🔒 Locks'], ['flood', '🌊 Antiflood'], ['spam', '🚫 Antispam'], ['welcome', '👋 Welcome'], ['goodbye', '🚪 Goodbye'],
  ['filters', '📝 Filters'], ['notes', '📚 Notes'], ['warn', '⚠️ Warnings'], ['rules', '📜 Rules'], ['verify', '🧩 Verification'],
];
const CYCLES = {
  'flood.mode': ['delete', 'warn', 'mute', 'kick', 'ban'], 'spam.mode': ['delete', 'warn', 'mute', 'kick', 'ban'], 'warn.mode': ['mute', 'ban', 'kick', 'none'],
  'captcha.mode': ['button', 'math'], 'captcha.action': ['kick', 'ban', 'mute'], 'reports.mode': ['group', 'pm', 'off'], 'welcome.clean': ['0', '300', '900', '3600'], 'raid.action': ['kick', 'ban', 'mute'],
};
const STEPS = { 'flood.limit': [2, 50], 'warn.limit': [1, 100], 'flood.window': [2, 60] };
const TOGGLES = ['selfmod.on', 'raid.on', 'clean.service', 'clean.commands', 'clean.bots', 'flood.on', 'spam.on', 'welcome.on', 'welcome.rules_button', 'goodbye.on', 'notes.public', 'captcha.on'];

const tbtn = (label, s, key, section) => btn(`${label}: ${YN(s.bool(key))}`, `gs:${section}:t:${key}`, { style: s.bool(key) ? 'success' : 'danger' });
const cbtn = (label, s, key, section, fmt = (v) => v) => btn(`${label}: ${fmt(s.get(key))}`, `gs:${section}:c:${key}`);
const back = [btn('◀️ Back', 'gs:main', { style: 'primary' }), btn('❌ Close', 'gs:x', { style: 'danger' })];

export async function mainScreen(ctx, group, chat) {
  const s = await loadSettings(ctx, group);
  const rows = [];
  for (let i = 0; i < SECTIONS.length; i += 2) rows.push(SECTIONS.slice(i, i + 2).map(([id, label]) => btn(label, `gs:${id}`, { style: 'none' })));
  rows.push([btn('❌ Close', 'gs:x', { style: 'danger' })]);
  const status = [
    field('🔒', 'Active locks', s.locks().size), field('🌊', 'Antiflood', YN(s.bool('flood.on'))), field('🚫', 'Antispam', YN(s.bool('spam.on'))),
    field('🧩', 'Verification', YN(s.bool('captcha.on'))), field('👋', 'Welcome', YN(s.bool('welcome.on'))), field('⚠️', 'Warn limit', s.int('warn.limit')),
  ].join('\n');
  return { text: `${boxHtml("⚙️", "Group Settings")}\n${esc(chat.title || '')}\n\n${status}\n\n${SEP}\nChoose a category. Only administrators can change settings.`, keyboard: markup(rows) };
}

/** 🛡️ SECURITY OVERVIEW — read-only summary of the protections this bot really has, with their real state. */
export async function securityScreen(ctx, group, s) {
  const locks = [...s.locks()].sort();
  const blN = await countBlacklist(ctx.db, group).catch(() => 0);
  const rows = [
    field('🛑', 'Anti-spam', YN(s.bool('spam.on'))),
    field('🚨', 'Antiflood', YN(s.bool('flood.on'))),
    field('🔐', 'Verification', YN(s.bool('captcha.on'))),
    field('🚧', 'Anti-raid', YN(s.bool('raid.on'))),
    field('🚫', 'Blacklist', `${blN} word${blN === 1 ? '' : 's'} • action: ${s.get('bl.mode')}`),
    field('📢', 'Reports', s.get('reports.mode')),
    field('🔒', 'Active locks', locks.length ? `${locks.length} (${locks.join(', ')})` : 'none'),
  ].join('\n');
  return {
    text: `${boxHtml('🛡️', 'Security Overview')}\n\n${rows}\n\n💡 <i>Open a section to change it. These are heuristics: they reduce abuse but cannot stop every attacker.</i>`,
    keyboard: markup([
      [btn('🔒 Locks', 'gs:locks', { style: 'none' }), btn('🚨 Antiflood', 'gs:flood', { style: 'none' })],
      [btn('🛑 Antispam', 'gs:spam', { style: 'none' }), btn('🔐 Verification', 'gs:verify', { style: 'none' })],
      back,
    ]),
  };
}

export async function securityCommand(ctx, msg) {
  const sr = await senderRight(ctx, msg, null);
  if (!sr.ok) return reply(ctx, msg, sr.error);
  const group = await getGroup(ctx.db, msg.chat.id);
  const screen = await securityScreen(ctx, group, await loadSettings(ctx, group));
  return reply(ctx, msg, screen.text, { reply_markup: screen.keyboard });
}

async function sectionScreen(ctx, group, chat, id) {
  const s = await loadSettings(ctx, group);
  switch (id) {
    case 'sec': return securityScreen(ctx, group, s);
    case 'mod': return {
      text: `${boxHtml("🛡️", "Moderation")}\n\n${field('🎛️', 'Reports', s.get('reports.mode'))}\n${field('🙋', 'Self-moderation (/banme /muteme)', YN(s.bool('selfmod.on')))}\n${field('🚨', 'Anti-raid detection', YN(s.bool('raid.on')))}\n${field('🧹', 'Delete service messages', YN(s.bool('clean.service')))}\n${field('🧹', 'Delete handled commands', YN(s.bool('clean.commands')))}\n${field('🧹', 'Delete inline-bot messages', YN(s.bool('clean.bots')))}`,
      keyboard: markup([[cbtn('Reports', s, 'reports.mode', 'mod')], [tbtn('Self-mod', s, 'selfmod.on', 'mod')], [tbtn('Anti-raid', s, 'raid.on', 'mod')], [tbtn('Clean service', s, 'clean.service', 'mod')], [tbtn('Clean commands', s, 'clean.commands', 'mod')], [tbtn('Clean inline bots', s, 'clean.bots', 'mod')], back]),
    };
    case 'locks': {
      const locks = s.locks();
      const rows = []; const types = Object.keys(LOCK_TYPES);
      for (let i = 0; i < types.length; i += 2) rows.push(types.slice(i, i + 2).map((t) => btn(`${locks.has(t) ? '🔒' : '🔓'} ${t}`, `gs:locks:l:${t}`, { plain: true, style: locks.has(t) ? 'success' : 'none' })));
      rows.push(back);
      return { text: `${boxHtml("🔒", "Locks")}\n\nTap a type to lock / unlock it.\n${field('📊', 'Active locks', locks.size)}`, keyboard: markup(rows) };
    }
    case 'flood': return {
      text: `${boxHtml("🌊", "Antiflood")}\n\n${field('📌', 'Status', YN(s.bool('flood.on')))}\n${field('📊', 'Limit', `${s.int('flood.limit')} messages in ${s.int('flood.window')}s`)}\n${field('⚡', 'Action', s.get('flood.mode'))}`,
      keyboard: markup([[tbtn('Antiflood', s, 'flood.on', 'flood')], [btn('➖ Limit', 'gs:flood:s:flood.limit:-1'), btn(`${s.int('flood.limit')}`, 'gs:flood'), btn('➕ Limit', 'gs:flood:s:flood.limit:1')], [cbtn('Action', s, 'flood.mode', 'flood')], back]),
    };
    case 'spam': return {
      text: `${boxHtml("🚫", "Antispam")}\n\n${field('📌', 'Status', YN(s.bool('spam.on')))}\n${field('⚡', 'Action', s.get('spam.mode'))}\n\nChecks: identical messages, repeated links, mass mentions, forward bursts.`,
      keyboard: markup([[tbtn('Antispam', s, 'spam.on', 'spam')], [cbtn('Action', s, 'spam.mode', 'spam')], back]),
    };
    case 'welcome': return {
      text: `${boxHtml("👋", "Welcome")}\n\n${field('📌', 'Status', YN(s.bool('welcome.on')))}\n${field('📜', 'Rules button', YN(s.bool('welcome.rules_button')))}\n${field('🧹', 'Auto-delete', s.int('welcome.clean') ? formatDuration(s.int('welcome.clean')) : 'off')}\n${field('📦', 'Custom message', (await getGreeting(ctx.db, group, 'welcome')) ? 'yes' : 'default')}\n\nEdit with /setwelcome.`,
      keyboard: markup([[tbtn('Welcome', s, 'welcome.on', 'welcome')], [tbtn('Rules button', s, 'welcome.rules_button', 'welcome')], [cbtn('Auto-delete', s, 'welcome.clean', 'welcome', (v) => (Number(v) ? formatDuration(Number(v)) : 'off'))], back]),
    };
    case 'goodbye': return {
      text: `${boxHtml("🚪", "Goodbye")}\n\n${field('📌', 'Status', YN(s.bool('goodbye.on')))}\n${field('📦', 'Custom message', (await getGreeting(ctx.db, group, 'goodbye')) ? 'yes' : 'default')}\n\nEdit with /setgoodbye.`,
      keyboard: markup([[tbtn('Goodbye', s, 'goodbye.on', 'goodbye')], back]),
    };
    case 'filters': return { text: `${boxHtml("📝", "Filters")}\n\n${field('📊', 'Filters', await countFilters(ctx.db, group))}\n${field('🚫', 'Blacklist entries', await countBlacklist(ctx.db, group))}\n\nManage with /filter, /filters, /stop and /addblacklist.`, keyboard: markup([back]) };
    case 'notes': return {
      text: `${boxHtml("📚", "Notes")}\n\n${field('📊', 'Notes', (await listNotes(ctx.db, group)).length)}\n${field('👥', 'Members can read notes', YN(s.bool('notes.public')))}\n\nManage with /save, /get, /notes and /clear.`,
      keyboard: markup([[tbtn('Members can read', s, 'notes.public', 'notes')], back]),
    };
    case 'warn': return {
      text: `${boxHtml("⚠️", "Warnings")}\n\n${field('📊', 'Limit', s.int('warn.limit'))}\n${field('⚡', 'At the limit', s.get('warn.mode'))}\n${field('⏳', 'Expire after', s.int('warn.time') ? formatDuration(s.int('warn.time')) : 'never')}`,
      keyboard: markup([[btn('➖ Limit', 'gs:warn:s:warn.limit:-1'), btn(`${s.int('warn.limit')}`, 'gs:warn'), btn('➕ Limit', 'gs:warn:s:warn.limit:1')], [cbtn('At the limit', s, 'warn.mode', 'warn')], back]),
    };
    case 'rules': return {
      text: `${boxHtml("📜", "Rules")}\n\n${field('📌', 'Rules set', (await getRules(ctx, group)) ? 'yes' : 'no')}\n\nSet with /setrules, show with /rules.`,
      keyboard: markup([[btn('📜 Show rules', 'gs:rules:show')], back]),
    };
    case 'verify': return {
      text: `${boxHtml("🧩", "Verification")}\n\n${field('📌', 'Status', YN(s.bool('captcha.on')))}\n${field('🎛️', 'Mode', s.get('captcha.mode'))}\n${field('⏳', 'Time', formatDuration(s.int('captcha.time')))}\n${field('⚡', 'If not verified', s.get('captcha.action'))}`,
      keyboard: markup([[tbtn('Verification', s, 'captcha.on', 'verify')], [cbtn('Mode', s, 'captcha.mode', 'verify')], [cbtn('If not verified', s, 'captcha.action', 'verify')], back]),
    };
    default: return null;
  }
}

export async function settingsCommand(ctx, msg) {
  const sr = await senderRight(ctx, msg, null);
  if (!sr.ok) return reply(ctx, msg, sr.error);
  const group = await getGroup(ctx.db, msg.chat.id);
  const screen = await mainScreen(ctx, group, msg.chat);
  return reply(ctx, msg, screen.text, { reply_markup: screen.keyboard });
}

/** gs:main | gs:x | gs:<section> | gs:<section>:t:<key> | :c:<key> | :s:<key>:<delta> | gs:locks:l:<type> | gs:rules:show */
export async function settingsCallback(ctx, cq, parts) {
  const chat = cq.message?.chat;
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return ctx.tg.answerCallbackQuery(cq.id, 'Groups only.', true);
  const sr = await senderRight(ctx, { chat, from: cq.from }, null);
  if (!sr.ok) return ctx.tg.answerCallbackQuery(cq.id, '🔒 Only administrators can use settings.', true);
  const group = await getGroup(ctx.db, chat.id);
  const mid = cq.message.message_id;
  const section = parts[1];

  if (section === 'x') { await ctx.tg.answerCallbackQuery(cq.id); return ctx.tg.deleteMessage(chat.id, mid).catch(() => {}); }

  let notice;
  const kind = parts[2];
  if (kind === 't' && TOGGLES.includes(parts[3])) {
    const s = await loadSettings(ctx, group);
    const next = !s.bool(parts[3]);
    if (parts[3] === 'captcha.on' && next && (await botRightProblem(ctx, chat.id, 'can_restrict_members'))) { await ctx.tg.answerCallbackQuery(cq.id, 'Give me the “Ban users” admin right first.', true); return undefined; }
    await setGroupSetting(ctx.db, group, parts[3], next ? '1' : '0');
  } else if (kind === 'c' && CYCLES[parts[3]]) {
    const s = await loadSettings(ctx, group);
    const list = CYCLES[parts[3]];
    const i = list.indexOf(String(s.get(parts[3])));
    await setGroupSetting(ctx.db, group, parts[3], list[(i + 1) % list.length]);
  } else if (kind === 's' && STEPS[parts[3]]) {
    const [lo, hi] = STEPS[parts[3]];
    const s = await loadSettings(ctx, group);
    const v = Math.min(hi, Math.max(lo, s.int(parts[3]) + (Number(parts[4]) === -1 ? -1 : 1)));
    await setGroupSetting(ctx.db, group, parts[3], v);
  } else if (kind === 'l' && LOCK_TYPES[parts[3]]) {
    const s = await loadSettings(ctx, group);
    const lock = !s.locks().has(parts[3]);
    const r = await applyLocks(ctx, chat, cq.from.id, [parts[3]], lock);
    if (lock && r.delProblem) notice = 'Locked — but I need the “Delete messages” right to enforce it.';
  } else if (kind === 'show' && section === 'rules') {
    const { sendRules } = await import('./rules.js');
    const sent = await sendRules(ctx, chat, group, { user: cq.from }).catch(() => null);
    await ctx.tg.answerCallbackQuery(cq.id, sent ? undefined : 'No rules set yet.');
    return undefined;
  } else if (kind) {
    await ctx.tg.answerCallbackQuery(cq.id, 'Unknown button.', true);
    return undefined;
  }

  const screen = section === 'main' ? await mainScreen(ctx, group, chat) : await sectionScreen(ctx, group, chat, section);
  if (!screen) return ctx.tg.answerCallbackQuery(cq.id, 'Unknown button.', true);
  await ctx.tg.answerCallbackQuery(cq.id, notice, Boolean(notice));
  await ctx.tg.editMessageText(chat.id, mid, screen.text, { reply_markup: screen.keyboard }).catch((e) => { if (!/not modified/i.test(String(e?.message))) throw e; });
  return undefined;
}
