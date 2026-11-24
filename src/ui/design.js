// Presentation-only building blocks for every bot message. Nothing in here talks to Telegram or the database:
// the helpers take plain data and return HTML strings / keyboard objects.

import { esc } from './escape.js';
import { heading, subheading } from './typography.js';

export const BOX_TOP = '╭━━━━━━━━━━━━━━━━━━╮';
export const BOX_BOTTOM = '╰━━━━━━━━━━━━━━━━━━╯';
export const DIVIDER = '━━━━━━━━━━━━━━━━━━';

/** ╭━━━╮ / ✨ 𝗧𝗜𝗧𝗟𝗘 / ╰━━━╯ — the single heading style used across the whole bot. */
export function box(emoji, text) {
  return boxHtml(emoji, esc(text));
}

/** Same as box() for text that is already HTML-escaped (e.g. headings written as `Backup &amp; Restore`). */
export function boxHtml(emoji, html) {
  // Every heading is a quotation block with bold Unicode letters (no frame lines).
  return blockquote(`${emoji ? `${emoji} ` : ''}${heading(html)}`);
}

/** Short heading for inline sections inside a message. */
/** A command name shown in bold italic with a capital first letter: <b><i>/Ban</i></b>. Telegram treats commands case-insensitively. */
export function cmdHtml(usage) {
  const text = String(usage || '');
  const m = /^(\/)(\S+)([\s\S]*)$/.exec(text);
  if (!m) return `<code>${esc(text)}</code>`;
  const name = m[2].charAt(0).toUpperCase() + m[2].slice(1);
  return `<b><i>/${esc(name)}</i></b>${m[3] ? ` <code>${esc(m[3].trim())}</code>` : ''}`;
}
export const cmdUsage = cmdHtml;

export const section = (emoji, text) => `${emoji ? `${emoji} ` : ''}${subheading(text)}`;

/** Telegram blockquote around already-escaped / already-built HTML. */
export const blockquote = (html, { expandable = false } = {}) => `<blockquote${expandable ? ' expandable' : ''}>${html}</blockquote>`;

/** "📌 <b>Label:</b> value" — label is real bold, value escaped unless raw. */
export function row(emoji, label, value, { raw = false } = {}) {
  return `${emoji} <b>${esc(label)}:</b> ${raw ? value : esc(value)}`;
}

const join = (parts) => parts.filter((p) => p !== null && p !== undefined && p !== '').join('\n\n');

// ------------------------------------------------------------------ message formatters

/** Role-aware /start text. role: 'owner' | 'sudo' | 'user'. `stats` = { users, groups } (real counts) is optional. */
export function formatWelcome({ botName, firstName, version, role = 'user', stats = null } = {}) {
  const name = esc(botName || 'the bot');
  const hello = firstName ? `Hey <b>${esc(firstName)}</b> 👋` : 'Hey there 👋';
  const head = {
    owner: ['Welcome Boss!', `You are the <b>Main Owner</b> of <b>${name}</b>. All owner controls are available to you.`],
    sudo: ['Welcome Moderator!', `You are an authorized <b>Sudo Moderator</b> of <b>${name}</b>. Your moderator panel is ready.`],
    user: ['Welcome!', `Welcome to <b>${name}</b>! Explore the available features below.`],
  }[role] || ['Welcome!', `Welcome to <b>${name}</b>!`];
  const features = role === 'user'
    ? '🛡 Group management &amp; moderation\n🎌 Anime info &amp; airing schedule\n🌐 Translation &amp; 🖼 image search\n🧩 Custom inline buttons'
    : '🛡 Group management &amp; global bans\n📊 <b><i>/Panel</i></b> — users, groups &amp; stats\n📡 Broadcasts &amp; backups\n🎌 Anime, translation &amp; image tools';
  // One heading quote, one greeting quote (the features sit in an expandable quote). Stats and version are plain lines.
  return join([
    blockquote(`🎉 <b>${heading(head[0])}</b>\n${hello}\n${head[1]}`),
    blockquote(features, { expandable: true }),
    stats ? statsLine(stats, role) : '',
    version ? `🔖 <i>${name} v${esc(version)}</i>` : '',
  ]);
}

/** Role-aware statistics: the sudo count is shown to the Main Owner only. */
export function statsLine(stats, role) {
  const parts = [`👥 Users: ${stats.users}`, `🌐 Groups: ${stats.groups}`];
  if (role === 'owner') parts.push(`🛡️ Sudo: ${stats.sudo ?? 0}`);
  return `<code>${parts.join(' • ')}</code>`; // monospace, as the other figures in the welcome
}

export function formatSuccess(titleText = 'Success', detail = '') {
  return join([box('✅', titleText), detail ? blockquote(esc(detail)) : '']);
}
export function formatError(titleText = 'Something Went Wrong', detail = '') {
  return join([box('❌', titleText), detail ? blockquote(esc(detail)) : '']);
}
export function formatWarning(titleText = 'Warning', detail = '') {
  return join([box('⚠️', titleText), detail ? blockquote(esc(detail)) : '']);
}
export function formatInfo(titleText, detail = '', { rows = [], footer = '' } = {}) {
  return join([box('ℹ️', titleText), detail ? esc(detail) : '', rows.filter(Boolean).join('\n'), footer]);
}

/** Status / settings panel: rows are [emoji, label, value] or ready-made strings. */
export function formatStatus(titleText, rows = [], { emoji = '📊', footer = '' } = {}) {
  const lines = rows.filter(Boolean).map((r) => (Array.isArray(r) ? row(r[0], r[1], r[2]) : r));
  return join([box(emoji, titleText), lines.join('\n'), footer]);
}

/** ON / OFF indicator used by every settings panel (always reflects a real stored value). */
export const onOff = (value) => (value ? '🟢 ON' : '🔴 OFF');

/**
 * Help card for one command. `cmd` is a registry entry: { names, usage, description, access }.
 * Only information that exists in the registry is shown.
 */
export function formatCommandHelp(cmd, { access = '' } = {}) {
  const [main, ...aliases] = cmd.names;
  const usageLines = [].concat(cmd.usage || `/${main}`).map((u) => `• ${cmdUsage(u)}`).join('\n');
  return join([
    box(cmd.emoji || '📖', `/${main} command`),
    `${section('📝', 'Description')}\n${blockquote(esc(cmd.description || ''))}`,
    `${section('⚙️', 'Usage')}\n${blockquote(usageLines)}`,
    aliases.length ? `${section('🔁', 'Aliases')}\n${aliases.map((a) => `<code>/${esc(a)}</code>`).join('  ')}` : '',
    access ? `${section('🔐', 'Who can use it')}\n${blockquote(esc(access))}` : '',
  ]);
}

/** One moderation action, as shown after Telegram confirmed it. `fields` = [emoji, label, htmlValue] */
export function formatModerationLog({ emoji, titleText, fields = [], note = '' }) {
  return join([box(emoji, titleText), fields.filter(Boolean).map(([e, l, v]) => row(e, l, v, { raw: true })).join('\n'), note ? blockquote(esc(note)) : '']);
}

/** Menu screen: heading box, optional intro, optional footer hint. */
export function formatMenu(emoji, titleText, intro = '', hint = '') {
  return join([box(emoji, titleText), intro ? blockquote(esc(intro)) : '', hint ? blockquote(`💡 <i>${esc(hint)}</i>`) : '']);
}
