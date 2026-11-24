// One resolver for every "send this content" command: broadcast, announce, buttons, filters, notes, rules,
// group and private welcome. In one go it reads:
//   - media   : from the command message itself (a media message whose caption is the command), else the replied message
//   - text    : typed after the command, else the replied message's text / caption
//   - buttons : a trailing block of "(Label - link)" lines, found in the typed text AND in the replied text,
//               and added together (replied buttons first, then typed buttons)
// Nothing here is executed; it only describes what to send.

import { extractButtons, formatParseErrors, BUTTON_FORMAT_HELP } from './buttonParser.js';
import { sliceWithEntities, withoutCommandEntities } from '../utils/entities.js';
import { boxHtml } from '../ui/design.js';
import { esc } from '../utils/formatter.js';

const MEDIA_ORDER = ['animation', 'video_note', 'sticker', 'voice', 'audio', 'video', 'photo', 'document'];
/** Telegram cannot put a caption on these, so their text is sent as a separate message. */
export const NO_CAPTION = ['sticker', 'video_note'];
export const CAPTION_LIMIT = 1024;
export const TEXT_LIMIT = 4096;

/** { type, file_id } for the media in a Telegram message, or null. */
export function mediaOf(m) {
  if (!m) return null;
  for (const type of MEDIA_ORDER) {
    const v = m[type];
    if (!v) continue;
    if (type === 'photo') return Array.isArray(v) && v.length ? { type, file_id: v[v.length - 1].file_id } : null;
    return v.file_id ? { type, file_id: v.file_id } : null;
  }
  return null;
}

function buttonError(errors) {
  return `${boxHtml('⚠️', 'Invalid Button Format')}\n\n${esc(formatParseErrors(errors))}\n\n📖 <b>Format</b>\n<code>${esc(BUTTON_FORMAT_HELP)}</code>`;
}

/**
 * Link buttons already on the replied post (its inline keyboard), so they are copied with the post.
 * Callback buttons belong to the bot that made the post and cannot be copied; they are counted instead.
 */
function rowsFromMarkup(markup) {
  const rows = [];
  let skipped = 0;
  for (const row of markup?.inline_keyboard || []) {
    const out = [];
    for (const b of row) {
      if (b.url) out.push({ text: b.text, url: b.url, ...(b.style ? { style: b.style } : {}) });
      else skipped++;
    }
    if (out.length) rows.push(out);
  }
  return { rows, skipped };
}

/** Splits one text into its body (without the trailing button block) and its button rows. */
function readSource(text, entities) {
  const ex = extractButtons(text);
  if (ex.found && !ex.ok) return { errors: ex.errors };
  const body = ex.found ? sliceWithEntities(text, entities, 0, ex.textEnd) : sliceWithEntities(text, entities, 0);
  return { text: body.text, entities: body.entities, rows: ex.rows };
}

/**
 * @param msg        the command message
 * @param argsStart  index in msg.text / msg.caption where the typed content begins (after the command and any target)
 * Returns { ok:true, text, entities, media, buttons, mediaType } | { ok:false, error: html | 'empty' }.
 * `text` is raw Telegram text; `entities` belong to it.
 */
export function resolveSmartContent(msg, { argsStart = 0 } = {}) {
  const own = msg.text ?? msg.caption ?? '';
  const ownEntities = withoutCommandEntities(msg.text !== undefined ? msg.entities : msg.caption_entities);
  const typed = sliceWithEntities(own, ownEntities, argsStart);

  const replied = msg.reply_to_message || null;
  const repText = replied ? (replied.text ?? replied.caption ?? '') : '';
  const repEntities = replied ? withoutCommandEntities(replied.text !== undefined ? replied.entities : replied.caption_entities) : [];

  const a = readSource(typed.text, typed.entities);
  const b = replied ? readSource(repText, repEntities) : { text: '', entities: [], rows: [] };
  const errors = [...(a.errors || []), ...(b.errors || [])];
  if (errors.length) return { ok: false, error: buttonError(errors) };

  const media = mediaOf(msg) || (replied ? mediaOf(replied) : null);
  // Typed text wins; the replied text is used only when nothing was typed after the command.
  const useTyped = a.text.trim() !== '';
  const text = useTyped ? a.text : b.text;
  const entities = useTyped ? a.entities : b.entities;
  const copied = replied ? rowsFromMarkup(replied.reply_markup) : { rows: [], skipped: 0 };
  // Buttons: those already on the replied post, then the ones written as lines in its text, then typed ones.
  const buttons = [...copied.rows, ...b.rows, ...a.rows];

  if (!text.trim() && !media) return { ok: false, error: 'empty' };
  // Nothing typed and a post replied to: the post itself can be copied, which keeps every formatting entity and
  // every button (including callback buttons that cannot be rebuilt from their data).
  const keyboardCount = (replied?.reply_markup?.inline_keyboard || []).reduce((n, row) => n + row.length, 0);
  const canCopy = Boolean(replied) && !useTyped && a.rows.length === 0 && !mediaOf(msg);
  // Copy keeps the post's link buttons (with their colours). Callback buttons belong to the bot that made the post,
  // so they are not carried over (a copy would only show buttons that do nothing).
  const urlRows = copied.rows;
  const copyFrom = canCopy ? { from_chat_id: replied.chat.id, message_id: replied.message_id, urlRows, keyboardCount, droppedCallbacks: copied.skipped } : null;

  return { ok: true, text: text.trim() ? text : '', entities: text.trim() ? entities : [], media, buttons, mediaType: media?.type || null, skippedButtons: copied.skipped, copyFrom };
}
