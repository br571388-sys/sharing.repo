// Builds a sendable "payload" from a Telegram message (text, media, buttons) and sends it.
// Shared by /broadcast, /allbroadcast, /announce and /button.

import { resolveSmartContent, NO_CAPTION, CAPTION_LIMIT, TEXT_LIMIT } from '../../keyboards/smartContent.js';
import { rowsToReplyMarkup } from '../../keyboards/inlineKeyboard.js';
import { sliceWithEntities, withoutCommandEntities } from '../../utils/entities.js';
import { esc } from '../../utils/formatter.js';
import { boxHtml } from '../../ui/design.js';

const MEDIA_KEYS = ['photo', 'video', 'document', 'animation', 'audio', 'voice', 'video_note', 'sticker', 'poll', 'location', 'contact', 'venue', 'dice'];
export const hasMedia = (m) => MEDIA_KEYS.some((k) => m && m[k] !== undefined);


/** Splits "text + trailing button rows" and keeps entity formatting for the text part. */
function splitButtons(text, entities) {
  const ex = extractButtons(text);
  if (!ex.found) return { text, entities: entities || [], rows: [], errors: [] };
  const part = sliceWithEntities(text, entities || [], 0, ex.textEnd);
  return { text: part.text, entities: part.entities, rows: ex.rows, errors: ex.errors };
}

const buttonError = (errors) => ({
  ok: false,
  error: `${boxHtml("⚠️", "Invalid Button Format")}\n\n${esc(formatParseErrors(errors))}\n\n📖 <b>Format</b>\n<code>${esc(BUTTON_FORMAT_HELP)}</code>`,
});

/**
 * Builds the payload for broadcast / announce / buttons from one command message (see keyboards/smartContent.js).
 * @param contentStart  index in msg.text / msg.caption where the content (after command/target) begins
 * Returns { ok: true, payload, buttonCount } or { ok: false, error: '<html>' | 'empty' }.
 */
export async function buildPayload(ctx, msg, contentStart) {
  const r = resolveSmartContent(msg, { argsStart: contentStart });
  if (!r.ok) return r.error === 'empty' ? { ok: false, error: 'empty' } : { ok: false, error: r.error };
  if (r.copyFrom) {
    // Copy of the replied post: formatting, media and all of its buttons come along unchanged.
    const urlCount = r.copyFrom.urlRows.reduce((n, row) => n + row.length, 0);
    const reply_markup = await rowsToReplyMarkup(ctx.db, r.copyFrom.urlRows); // URL buttons only; {} rows = no keyboard
    return {
      ok: true,
      payload: { kind: 'copy', from_chat_id: r.copyFrom.from_chat_id, message_id: r.copyFrom.message_id, reply_markup },
      buttonCount: urlCount,
      droppedCallbacks: r.copyFrom.droppedCallbacks,
    };
  }
  const tooLong = (what, limit, n) => ({ ok: false, error: `${boxHtml('⚠️', `${what} Too Long`)}\n\n${what === 'Caption' ? 'Captions' : 'Text'} can have at most ${limit} characters (yours has ${n}).` });
  let payload;
  if (r.media) {
    const limit = NO_CAPTION.includes(r.mediaType) ? TEXT_LIMIT : CAPTION_LIMIT;
    if (r.text.length > limit) return tooLong('Caption', limit, r.text.length);
    payload = { kind: 'media', mediaType: r.mediaType, fileId: r.media.file_id, text: r.text, entities: r.entities };
  } else {
    if (r.text.length > TEXT_LIMIT) return tooLong('Message', TEXT_LIMIT, r.text.length);
    payload = { kind: 'text', text: r.text, entities: r.entities };
  }
  const rows = r.buttons;
  if (rows.length) payload.reply_markup = await rowsToReplyMarkup(ctx.db, rows);
  return { ok: true, payload, buttonCount: rows.reduce((n, row) => n + row.length, 0) };
}

const MEDIA_METHOD = {
  photo: ['sendPhoto', 'photo'], video: ['sendVideo', 'video'], document: ['sendDocument', 'document'],
  animation: ['sendAnimation', 'animation'], audio: ['sendAudio', 'audio'], voice: ['sendVoice', 'voice'],
  sticker: ['sendSticker', 'sticker'], video_note: ['sendVideoNote', 'video_note'],
};

/** Sends a payload to one chat. Throws TelegramError. `autoRetry:false` so broadcasts can honour retry_after. */
export function sendPayload(ctx, chatId, payload, { autoRetry = false, extra = {} } = {}) {
  if (payload.kind === 'media') {
    const [method, field] = MEDIA_METHOD[payload.mediaType] || ['sendDocument', 'document'];
    const markup = payload.reply_markup ? { reply_markup: payload.reply_markup } : {};
    const hasText = Boolean(payload.text);
    if (!NO_CAPTION.includes(payload.mediaType) || !hasText) {
      // Media with its text as the caption (and the buttons under it).
      return ctx.tg.call(method, {
        chat_id: chatId, [field]: payload.fileId,
        ...(hasText && !NO_CAPTION.includes(payload.mediaType) ? { caption: payload.text, ...(payload.entities?.length ? { caption_entities: payload.entities } : {}) } : {}),
        ...markup, ...extra,
      }, { autoRetry });
    }
    // Sticker / video note: no caption possible, so the media is sent first and the text (with buttons) after it.
    return ctx.tg.call(method, { chat_id: chatId, [field]: payload.fileId, ...extra }, { autoRetry })
      .then(() => ctx.tg.call('sendMessage', {
        chat_id: chatId, text: payload.text,
        ...(payload.entities?.length ? { entities: payload.entities } : {}),
        ...markup, ...extra,
      }, { autoRetry }));
  }
  if (payload.kind === 'copy') {
    return ctx.tg.call('copyMessage', {
      chat_id: chatId, from_chat_id: payload.from_chat_id, message_id: payload.message_id,
      ...(payload.caption !== undefined ? { caption: payload.caption, caption_entities: payload.caption_entities } : {}),
      ...(payload.reply_markup ? { reply_markup: payload.reply_markup } : {}),
      ...extra,
    }, { autoRetry });
  }
  return ctx.tg.call('sendMessage', {
    chat_id: chatId, text: payload.text,
    ...(payload.entities?.length ? { entities: payload.entities } : {}),
    ...(payload.reply_markup ? { reply_markup: payload.reply_markup } : {}),
    ...extra,
  }, { autoRetry });
}
