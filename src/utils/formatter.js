// Shared Telegram HTML message design. Every user-visible message goes through these helpers so the bot
// looks consistent, and every dynamic value is HTML-escaped so user input cannot break formatting.

import { esc } from '../ui/escape.js';
import { DIVIDER, box, formatWelcome } from '../ui/design.js';

export const SEP = DIVIDER;

export { esc };

export const bold = (t) => `<b>${esc(t)}</b>`;
export const italic = (t) => `<i>${esc(t)}</i>`;
export const code = (t) => `<code>${esc(t)}</code>`;
export const pre = (t) => `<pre>${esc(t)}</pre>`;
export const link = (text, url) => `<a href="${esc(url).replace(/"/g, '&quot;')}">${esc(text)}</a>`;
export const mention = (id, name) => `<a href="tg://user?id=${Number(id)}">${esc(name || 'user')}</a>`;
export const quote = (t) => `<blockquote>${esc(t)}</blockquote>`;
export const expandableQuote = (t) => `<blockquote expandable>${esc(t)}</blockquote>`;

/** "📌 <b>Label:</b> value" (value is escaped; pass { raw: true } for pre-built HTML). */
export function field(emoji, label, value, { raw = false } = {}) {
  return `${emoji} <b>${esc(label)}:</b> ${raw ? value : esc(value)}`;
}

/** Heading in the shared box style (see src/ui/design.js). */
export function title(emoji, text) {
  return box(emoji, text);
}

/** Generic card: header, optional field rows, optional body paragraphs, optional footer. */
export function panel({ emoji = 'ℹ️', title: heading, rows = [], body = [], footer = '' }) {
  const parts = [title(emoji, heading)];
  const fields = rows.filter(Boolean);
  if (fields.length) parts.push(fields.join('\n'));
  for (const b of [].concat(body).filter(Boolean)) parts.push(b);
  if (footer) parts.push(footer);
  return parts.join('\n\n');
}

export const messages = {
  loading(text = 'Please wait...', detail = 'Processing your request. This may take a few seconds.') {
    return `${box('⏳', text)}\n\n🔄 ${esc(detail)}`;
  },
  searching(emoji, what) {
    return `${box(emoji, what)}\n\n🔄 Processing your request. This may take a few seconds.`;
  },
  success(heading = 'Operation Completed', detail = 'Your request has been processed successfully.') {
    return `${box('✅', heading)}\n\n<blockquote>${esc(detail)}</blockquote>`;
  },
  error(heading = 'Something Went Wrong', detail = 'The request could not be completed. Please try again.') {
    return `${box('❌', heading)}\n\n<blockquote>${esc(detail)}</blockquote>`;
  },
  unavailable(detail = 'The requested service is temporarily unavailable. Please try again later.') {
    return `${box('❌', 'Service Unavailable')}\n\n<blockquote>${esc(detail)}</blockquote>`;
  },
  warning(heading, detail) {
    return `${box('⚠️', heading)}\n\n<blockquote>${esc(detail)}</blockquote>`;
  },
  denied(detail = "You don't have permission to use this command.") {
    return `${box('🔒', 'Access Denied')}\n\n<blockquote>${esc(detail)}</blockquote>`;
  },
  usage(usageLines, examples = [], note = '') {
    const lines = [].concat(usageLines).map((l) => code(l)).join('\n');
    const ex = [].concat(examples).filter(Boolean);
    let out = `${box('⚠️', 'Invalid Usage')}\n\n<blockquote>Please provide the required information.</blockquote>\n\n📖 <b>Usage</b>\n<blockquote>${lines}</blockquote>`;
    if (ex.length) out += `\n\n💡 <b>Example</b>\n<blockquote>${ex.map((e) => code(e)).join('\n')}</blockquote>`;
    if (note) out += `\n\n${esc(note)}`;
    return out;
  },
  notFound(what = 'No results found.', hint = '') {
    return `${box('🔍', 'No Results')}\n\n<blockquote>${esc(what)}${hint ? `\n💡 ${esc(hint)}` : ''}</blockquote>`;
  },
  groupOnly() {
    return messages.warning('Group Only', 'This command can only be used inside a group.');
  },
  privateOnly() {
    return messages.warning('Private Chat Only', 'Please use this command in a private chat with the bot.');
  },
  rateLimited(seconds) {
    return `${box('⏳', 'Slow Down')}\n\n<blockquote>Too many requests. Please try again in ${Math.max(1, Math.ceil(seconds))}s.</blockquote>`;
  },
};

export function welcomeMessage(botName = 'Bot', { firstName = '', version = '' } = {}) {
  return formatWelcome({ botName, firstName, version });
}

export function groupWelcomeMessage(botName, chatTitle) {
  return [
    `${box('👋', 'Thanks for adding me')}\n\n<b>${esc(botName)}</b> is now active in <b>${esc(chatTitle || 'this group')}</b>.`,
    [
      '🎬 <code>/anime</code> — anime information',
      '📅 <code>/schedule</code> — airing schedule (IST)',
      '🌐 <code>/tr</code> — translate text',
      '🔎 <code>/image</code> — image search',
      '🧩 <code>/button</code> — build inline buttons (admins)',
      '💾 <code>/backup</code> — group backup (group owner)',
    ].join('\n'),
    '💡 Tap <b>Help</b> to see everything you can do here.',
  ].join('\n\n');
}

export function statsPanel(heading, emoji, rows) {
  return panel({ emoji, title: heading, rows: rows.map(([e, label, value]) => field(e, label, value)) });
}

export function percent(part, total) {
  if (!total) return '0%';
  const p = (part / total) * 100;
  return `${p >= 99.95 || Number.isInteger(p) ? Math.round(p) : p.toFixed(1)}%`;
}

/** Telegram messages max out at 4096 characters (after entity parsing). Splits on paragraph/line boundaries. */
export function splitMessage(text, max = 3800) {
  if (text.length <= max) return [text];
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}
