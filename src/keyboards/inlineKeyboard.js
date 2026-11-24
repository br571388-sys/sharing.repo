// Inline keyboard helpers: builders for the bot's own menus + conversion of parsed custom buttons.

import { saveButtonCallbacks } from '../database/state.js';
import { byteLength, sha256Hex } from '../utils/helpers.js';
import { isHttpUrl } from '../utils/validation.js';
import { decorate } from '../ui/buttons.js';

/** Bot-owned callback button. Label typography and colour come from the UI design system (src/ui/buttons.js). */
export const btn = (text, data, opts = {}) => {
  if (byteLength(data) > 64) throw new Error(`callback_data too long: ${data}`);
  return decorate({ text, callback_data: data }, opts);
};

export const urlBtn = (text, url, opts = {}) => decorate({ text, url }, opts);

/** Standard navigation rows. */
export const closeBtn = (label = '❌ Close') => btn(label, 'x:close', { style: 'danger' });
export const backCloseRow = (backData) => [btn('◀️ Back', backData, { style: 'primary' }), closeBtn()];

/** Builds an inline keyboard, dropping empty rows and buttons whose URL is missing/invalid. */
export function markup(rows) {
  const clean = rows
    .map((row) => row.filter((b) => b && (b.callback_data || (b.url && (isHttpUrl(b.url) || /^tg:\/\/user\?id=\d{1,15}$/.test(b.url))))))
    .filter((row) => row.length > 0);
  return { inline_keyboard: clean };
}

export const homeRow = (backData) => {
  const row = [];
  if (backData) row.push(btn('◀️ Back', backData, { style: 'primary' }));
  row.push(btn('🏠 Home', 'm:home', { style: 'primary' }));
  return row;
};

/** callback_data for a custom button: "cb:" + 20 hex chars of SHA-256(text). Same text -> same id. */
export async function callbackIdFor(text) {
  return `cb:${(await sha256Hex(text)).slice(0, 20)}`;
}

/**
 * Converts parsed button rows (from buttonParser) into a Telegram reply_markup and persists the pop-up texts
 * for callback buttons. Callback buttons can only ever *display* their stored text — nothing is executed.
 */
export async function rowsToReplyMarkup(db, rows) {
  const entries = [];
  const keyboard = [];
  for (const row of rows) {
    const out = [];
    for (const b of row) {
      if (b.url) {
        out.push({ text: b.text, url: b.url, ...(b.style ? { style: b.style } : {}) });
      } else {
        const id = await callbackIdFor(b.callback);
        entries.push({ id, text: b.callback });
        out.push({ text: b.text, callback_data: id, ...(b.style ? { style: b.style } : {}) });
      }
    }
    keyboard.push(out);
  }
  if (entries.length) await saveButtonCallbacks(db, entries);
  return { inline_keyboard: keyboard };
}

/** Splits buttons into balanced rows of `cols` (default two columns). */
export function gridRows(buttons, cols = 2) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += cols) rows.push(buttons.slice(i, i + cols));
  return rows;
}

/** Pagination row: [◀️ Prev] [1/3] [Next ▶️]. `dataFor(page)` builds the callback_data. Empty when there is one page. */
export function pagerRow(page, pages, dataFor) {
  if (pages <= 1) return [];
  const row = [];
  if (page > 0) row.push(btn('◀️ Prev', dataFor(page - 1), { style: 'primary' }));
  row.push(btn(`${page + 1}/${pages}`, 'x:noop', { plain: true, style: 'none' }));
  if (page + 1 < pages) row.push(btn('Next ▶️', dataFor(page + 1), { style: 'primary' }));
  return row;
}
