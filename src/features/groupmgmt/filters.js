// Filters (keyword -> saved reply) and Notes (named saved messages). Both are isolated per group and only ever send
// stored text / media / buttons back — no stored content is interpreted as code.

import { getGroup } from '../../database/groups.js';
import {
  countFilters, deleteAllFilters, deleteAllNotes, deleteFilter, deleteNote, getNote, listFilters, listNotes, saveFilter, saveNote,
} from '../../database/groupMod.js';
import { hitRateLimit } from '../../database/state.js';
import { setGroupSetting } from '../../database/settings.js';
import { btn, markup } from '../../keyboards/inlineKeyboard.js';
import { esc, field, messages } from '../../utils/formatter.js';
import { safeJsonParse } from '../../utils/helpers.js';
import { reply } from '../../handlers/helpers.js';
import { contentFromMessage, describeContent, sendContent } from './content.js';
import { senderRight } from './util.js';
import { blockquote, boxHtml } from '../../ui/design.js';

const MAX_FILTERS = 150;
const MAX_NOTES = 100;
const NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u;

async function adminGate(ctx, msg) {
  const sr = await senderRight(ctx, msg, null);
  return sr.ok ? null : reply(ctx, msg, sr.error);
}

/** Splits `"multi word keyword" response` / `keyword response`. Returns { keyword, consumed }. */
export function takeKeyword(args) {
  const m = /^\s*(?:"([^"]{1,64})"|(\S{1,64}))/.exec(args);
  if (!m) return null;
  return { keyword: (m[1] ?? m[2]).trim().toLowerCase(), consumed: m[0].length };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does `text` trigger this filter? Case-insensitive. 'word' = the keyword appears as a whole word / phrase. */
export function filterMatches(filter, text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  if (filter.match_mode === 'exact') return t.trim() === filter.keyword;
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(filter.keyword)}(?![\\p{L}\\p{N}_])`, 'u').test(t);
}

// ---------------------------------------------------------------- filters
export async function filterCommand(ctx, msg, args, cmd) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const group = await getGroup(ctx.db, msg.chat.id);
  let rest = args;
  let consumedFlag = 0;
  let mode = 'word';
  const flag = /^\s*--exact\b\s*/i.exec(rest);
  if (flag) { mode = 'exact'; consumedFlag = flag[0].length; rest = rest.slice(consumedFlag); }

  const kw = takeKeyword(rest);
  const usage = messages.usage(['/filter <keyword> <reply text>', '/filter <keyword> (reply to a message / media)', '/filter --exact <keyword> <reply text>', '/filter "two words" <reply text>'], ['/filter hello Welcome to our group!'], 'Keywords match whole words, ignoring case. Buttons: (Label - https://link) on new lines.');
  if (!kw) return reply(ctx, msg, usage);
  if ((await listFilters(ctx.db, group)).length >= MAX_FILTERS && !(await listFilters(ctx.db, group)).some((f) => f.keyword === kw.keyword)) {
    return reply(ctx, msg, messages.warning('Filter Limit Reached', `A group can have at most ${MAX_FILTERS} filters.`));
  }
  const built = contentFromMessage(msg, { argsStart: cmd.argsStart, skipChars: consumedFlag + kw.consumed });
  if (!built.ok) return reply(ctx, msg, built.error === 'empty' ? usage : built.error);

  await saveFilter(ctx.db, group, { keyword: kw.keyword, matchMode: mode, content: built.content, createdBy: msg.from.id });
  await setGroupSetting(ctx.db, group, 'flt.n', await countFilters(ctx.db, group));
  return reply(ctx, msg, `${boxHtml("📝", "Filter saved successfully!")}\n\n${field('🔑', 'Keyword', kw.keyword)}\n${field('🎯', 'Match', mode === 'exact' ? 'exact message' : 'whole word')}\n${field('📦', 'Reply', describeContent(built.content))}`);
}

export async function filtersCommand(ctx, msg) {
  const group = await getGroup(ctx.db, msg.chat.id);
  const rows = await listFilters(ctx.db, group);
  if (!rows.length) return reply(ctx, msg, `${boxHtml("📝", "Filters")}\n\nThere are no filters in this group yet.\nAdd one with <code>/filter hello Welcome!</code>`);
  const cards = rows.map((f) => {
    const c = safeJsonParse(f.content, {}) || {};
    const response = c.media ? `${c.media.type}${c.text ? ' + text' : ''}` : 'text';
    const buttons = c.buttons?.length ? c.buttons.flat().length : 0;
    return `• <code>${esc(f.keyword)}</code>\n  🎯 ${f.match_mode === 'exact' ? 'Exact message' : 'Whole word'} • 📦 ${esc(response)} • 🔘 ${buttons ? `${buttons} button${buttons === 1 ? '' : 's'}` : 'no buttons'} • 🟢 Active`;
  }).join('\n\n');
  return reply(ctx, msg, `${boxHtml('📝', 'Filters')}\n\n${field('📍', 'Group', msg.chat.title || 'this group')}\n${field('📊', 'Total', rows.length)}\n\n${blockquote(cards, { expandable: rows.length > 6 })}\n\nRemove one with <code>/stop &lt;keyword&gt;</code>.`);
}

export async function stopCommand(ctx, msg, args) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const group = await getGroup(ctx.db, msg.chat.id);
  const kw = takeKeyword(args);
  if (!kw) return reply(ctx, msg, messages.usage(['/stop <keyword>'], ['/stop hello']));
  if (!(await deleteFilter(ctx.db, group, kw.keyword))) return reply(ctx, msg, messages.warning('Filter Not Found', `There is no filter “${kw.keyword}”.`));
  await setGroupSetting(ctx.db, group, 'flt.n', await countFilters(ctx.db, group));
  return reply(ctx, msg, `${boxHtml("🗑️", "Filter removed")}\n\n${field('🔑', 'Keyword', kw.keyword)}`);
}

export async function stopallCommand(ctx, msg) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const group = await getGroup(ctx.db, msg.chat.id);
  const n = (await listFilters(ctx.db, group)).length;
  if (!n) return reply(ctx, msg, messages.warning('Nothing to Remove', 'There are no filters.'));
  return reply(ctx, msg, `⚠️ <b>Remove ALL ${n} filters?</b>\n\nThis cannot be undone.`, { reply_markup: markup([[btn('✅ Yes, remove all', 'gc:filters:go'), btn('❌ Cancel', 'gc:filters:no')]]) });
}

/** Runs filters on a normal group message. Returns true when a reply was sent. */
export async function runFilters(ctx, msg, group) {
  const text = msg.text ?? msg.caption;
  if (typeof text !== 'string' || !text || text.startsWith('/')) return false;
  if (msg.from && (await hitRateLimit(ctx.db, `flt:${msg.chat.id}:${msg.from.id}`, 6, 30)).allowed === false) return false;
  for (const row of await listFilters(ctx.db, group)) {
    const filter = { keyword: row.keyword, match_mode: row.match_mode };
    if (!filterMatches(filter, text)) continue;
    const content = safeJsonParse(row.content, null);
    if (!content) continue;
    try {
      await sendContent(ctx, msg.chat.id, content, { replyTo: msg.message_id, vars: { user: msg.from, chat: msg.chat }, threadId: msg.is_topic_message ? msg.message_thread_id : null });
    } catch { /* the saved media may be gone; stay quiet in the group */ }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- notes
export async function saveCommand(ctx, msg, args, cmd) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const group = await getGroup(ctx.db, msg.chat.id);
  const m = /^\s*(\S+)/.exec(args);
  const usage = messages.usage(['/save <name> <text>', '/save <name> (reply to a message / media)'], ['/save rules Please follow the group rules.'], 'Fetch with /get <name> or #<name>. Buttons: (Label - https://link) on new lines.');
  if (!m) return reply(ctx, msg, usage);
  const name = m[1].replace(/^#/, '').toLowerCase();
  if (!NAME_RE.test(name)) return reply(ctx, msg, messages.warning('Invalid Note Name', 'Use 1–32 letters, numbers, “_” or “-”.'));
  const existing = await listNotes(ctx.db, group);
  if (existing.length >= MAX_NOTES && !existing.some((n) => n.name === name)) return reply(ctx, msg, messages.warning('Note Limit Reached', `A group can have at most ${MAX_NOTES} notes.`));
  const built = contentFromMessage(msg, { argsStart: cmd.argsStart, skipChars: m[0].length });
  if (!built.ok) return reply(ctx, msg, built.error === 'empty' ? usage : built.error);
  await saveNote(ctx.db, group, { name, content: built.content, createdBy: msg.from.id });
  return reply(ctx, msg, `${boxHtml("📚", "Note saved successfully!")}\n\n${field('🏷️', 'Name', name)}\n${field('📦', 'Content', describeContent(built.content))}\n\nGet it with <code>/get ${esc(name)}</code> or <code>#${esc(name)}</code>.`);
}

async function sendNote(ctx, msg, group, name) {
  const row = await getNote(ctx.db, group, name);
  if (!row) return false;
  const content = safeJsonParse(row.content, null);
  if (!content) return false;
  await sendContent(ctx, msg.chat.id, content, { replyTo: msg.reply_to_message?.message_id ?? msg.message_id, vars: { user: msg.from, chat: msg.chat }, threadId: msg.is_topic_message ? msg.message_thread_id : null });
  return true;
}

async function notesAllowed(ctx, msg, group) {
  const { loadSettings } = await import('./settings.js');
  if ((await loadSettings(ctx, group)).bool('notes.public')) return true;
  return (await senderRight(ctx, msg, null)).ok;
}

export async function getCommand(ctx, msg, args) {
  const group = await getGroup(ctx.db, msg.chat.id);
  const name = args.trim().split(/\s+/)[0]?.replace(/^#/, '').toLowerCase();
  if (!name) return reply(ctx, msg, messages.usage(['/get <name>', '#<name>'], ['/get rules']));
  if (!(await notesAllowed(ctx, msg, group))) return reply(ctx, msg, messages.denied('Only administrators can read notes in this group.'));
  if (!(await sendNote(ctx, msg, group, name))) return reply(ctx, msg, messages.warning('Note Not Found', `There is no note called “${name}”. See /notes.`));
  return undefined;
}

export async function notesCommand(ctx, msg) {
  const group = await getGroup(ctx.db, msg.chat.id);
  if (!(await notesAllowed(ctx, msg, group))) return reply(ctx, msg, messages.denied('Only administrators can read notes in this group.'));
  const rows = await listNotes(ctx.db, group);
  if (!rows.length) return reply(ctx, msg, `${boxHtml("📚", "Notes")}\n\nThere are no notes in this group yet.\nSave one with <code>/save rules Please be kind.</code>`);
  return reply(ctx, msg, `📚 <b>Notes in ${esc(msg.chat.title || 'this group')}</b> (${rows.length})\n\n${rows.map((n) => `• <code>#${esc(n.name)}</code>`).join('\n')}\n\nGet one with <code>/get &lt;name&gt;</code> or <code>#name</code>.`);
}

export async function clearCommand(ctx, msg, args) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const group = await getGroup(ctx.db, msg.chat.id);
  const name = args.trim().split(/\s+/)[0]?.replace(/^#/, '').toLowerCase();
  if (!name) return reply(ctx, msg, messages.usage(['/clear <name>'], ['/clear rules']));
  if (!(await deleteNote(ctx.db, group, name))) return reply(ctx, msg, messages.warning('Note Not Found', `There is no note called “${name}”.`));
  return reply(ctx, msg, `${boxHtml("🗑️", "Note deleted")}\n\n${field('🏷️', 'Name', name)}`);
}

export async function clearallCommand(ctx, msg) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const group = await getGroup(ctx.db, msg.chat.id);
  const n = (await listNotes(ctx.db, group)).length;
  if (!n) return reply(ctx, msg, messages.warning('Nothing to Remove', 'There are no notes.'));
  return reply(ctx, msg, `⚠️ <b>Delete ALL ${n} notes?</b>\n\nThis cannot be undone.`, { reply_markup: markup([[btn('✅ Yes, delete all', 'gc:notes:go'), btn('❌ Cancel', 'gc:notes:no')]]) });
}

/** "#rules" style retrieval inside normal messages. Returns true when a note was sent. */
export async function runNoteHashtag(ctx, msg, group, settings) {
  const text = msg.text;
  if (typeof text !== 'string') return false;
  const m = /^#([\p{L}\p{N}_-]{1,32})\s*$/u.exec(text.trim());
  if (!m) return false;
  if (!settings.bool('notes.public') && !(await senderRight(ctx, msg, null)).ok) return false;
  try { return await sendNote(ctx, msg, group, m[1].toLowerCase()); } catch { return false; }
}

// ---------------------------------------------------------------- confirmation callbacks: gc:<filters|notes>:<go|no>
export async function confirmCallback(ctx, cq, parts) {
  const chat = cq.message?.chat;
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return ctx.tg.answerCallbackQuery(cq.id, 'Groups only.', true);
  const sr = await senderRight(ctx, { chat, from: cq.from }, null);
  if (!sr.ok) return ctx.tg.answerCallbackQuery(cq.id, '🔒 Only administrators can do this.', true);
  const [, what, answer] = parts;
  if (!['filters', 'notes'].includes(what)) return ctx.tg.answerCallbackQuery(cq.id, 'Unknown button.', true);
  if (answer !== 'go') {
    await ctx.tg.answerCallbackQuery(cq.id, 'Cancelled.');
    return ctx.tg.editMessageText(chat.id, cq.message.message_id, messages.warning('Cancelled', 'Nothing was removed.')).catch(() => {});
  }
  const group = await getGroup(ctx.db, chat.id);
  const n = what === 'filters' ? await deleteAllFilters(ctx.db, group) : await deleteAllNotes(ctx.db, group);
  if (what === 'filters') await setGroupSetting(ctx.db, group, 'flt.n', 0);
  await ctx.tg.answerCallbackQuery(cq.id, 'Done.');
  return ctx.tg.editMessageText(chat.id, cq.message.message_id, `🗑️ <b>${n} ${what} removed</b>`).catch(() => {});
}
