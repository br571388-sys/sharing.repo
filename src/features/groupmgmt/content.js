// Saved "content" used by filters, notes, welcome and goodbye: formatted text (Telegram HTML) + optional media + buttons.
// Stored as JSON: { text, media: { type, file_id } | null, buttons: [[{text,url|callback}]] | null }.
// Nothing stored here is ever executed — it is only sent back to Telegram as text / media / inline buttons.

import { resolveSmartContent, NO_CAPTION } from '../../keyboards/smartContent.js';
import { rowsToReplyMarkup } from '../../keyboards/inlineKeyboard.js';
import { entitiesToHtml, sliceWithEntities, withoutCommandEntities } from '../../utils/entities.js';
import { esc, messages } from '../../utils/formatter.js';
import { visibleLength } from '../../handlers/helpers.js';
import { boxHtml } from '../../ui/design.js';

export const TEXT_LIMIT = 3500;
export const CAPTION_LIMIT = 1000;

export { mediaOf } from '../../keyboards/smartContent.js';

/**
 * Builds stored content from a command message (text, media and buttons are all detected automatically).
 * `skipChars` removes leading words (e.g. the filter keyword) that are not part of the content.
 * Returns { ok:true, content } | { ok:false, error }.
 */
export function contentFromMessage(msg, { argsStart, skipChars = 0, allowEmpty = false } = {}) {
  const r = resolveSmartContent(msg, { argsStart: argsStart + skipChars });
  if (!r.ok) {
    if (r.error === 'empty') return allowEmpty ? { ok: true, content: { text: '', media: null, buttons: null } } : { ok: false, error: 'empty' };
    return { ok: false, error: r.error };
  }
  const html = r.text ? entitiesToHtml(r.text, r.entities) : '';
  const limit = r.media && !NO_CAPTION.includes(r.media.type) ? CAPTION_LIMIT : TEXT_LIMIT;
  if (visibleLength(html) > limit) {
    return { ok: false, error: messages.warning('Text Too Long', `${r.media && !NO_CAPTION.includes(r.media.type) ? 'Captions' : 'Messages'} can have at most ${limit} characters (yours has ${visibleLength(html)}).`) };
  }
  return { ok: true, content: { text: html, media: r.media, buttons: r.buttons.length ? r.buttons : null } };
}

const nameOf = (u) => [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.username || 'user';

/** Replaces {first} {last} {username} {mention} {id} {chatname} {count}. Values are HTML-escaped. */
export function applyPlaceholders(html, vars = {}) {
  const { user, chat, count } = vars;
  const map = {
    first: esc(user?.first_name || nameOf(user)),
    last: esc(user?.last_name || ''),
    username: user?.username ? `@${esc(user.username)}` : esc(nameOf(user)),
    mention: user ? `<a href="tg://user?id=${Number(user.id)}">${esc(nameOf(user))}</a>` : '',
    id: user ? String(user.id) : '',
    chatname: esc(chat?.title || ''),
    count: count === undefined || count === null ? '' : String(count),
  };
  return String(html).replace(/\{(first|last|username|mention|id|chatname|count)\}/gi, (_, k) => map[k.toLowerCase()]);
}

/** Sends stored content. Falls back to text when the media can no longer be used. Returns the sent message. */
export async function sendContent(ctx, chatId, content, { vars = null, replyTo = null, extraButtons = [], threadId = null, forceText = false } = {}) {
  const text = vars ? applyPlaceholders(content.text || '', vars) : (content.text || '');
  const keyboard = content.buttons?.length ? await rowsToReplyMarkup(ctx.db, content.buttons) : { inline_keyboard: [] };
  for (const row of extraButtons) keyboard.inline_keyboard.push(row);
  const extra = {
    ...(keyboard.inline_keyboard.length ? { reply_markup: keyboard } : {}),
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    ...(threadId ? { message_thread_id: threadId } : {}),
  };
  if (content.media && !forceText) {
    try {
      return await ctx.tg.sendMedia(chatId, content.media.type, content.media.file_id, { ...extra, ...(text ? { caption: text } : {}) });
    } catch (e) {
      if (!text) throw e; // media only and unusable: nothing to fall back to
    }
  }
  return ctx.tg.sendMessage(chatId, text || '​', extra);
}

/** Short human description for lists: "📷 photo + text". */
export function describeContent(c) {
  const parts = [];
  if (c.media) parts.push(`📎 ${c.media.type}`);
  if (c.text) parts.push('text');
  if (c.buttons?.length) parts.push('buttons');
  return parts.join(' + ') || 'empty';
}
