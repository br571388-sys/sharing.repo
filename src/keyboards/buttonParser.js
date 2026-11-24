// Custom inline-button text format. Pure module: no I/O, no Telegram or database access.
//
//   (Label - https://example.com)                 -> URL button
//   (Label - Plain text)                          -> callback button (shows the text as a pop-up)
//   (A - https://a.com) | (B - https://b.com)     -> two buttons in one row
//   a new line                                    -> a new row
//
// Colour (optional) goes after the closing parenthesis:
//   (Label - https://example.com) = green         -> green URL button
//   (Label - Some popup text) = red               -> red callback button
//   red = danger, blue = primary, green = success (the Telegram names primary/success/danger also work)
//
// Labels may contain nested parentheses:  (Carry On Jatta (2012) 480p. - https://t.me/c/1/2)
// When the right-hand side is a valid http(s) URL it is a URL button, otherwise a callback button.

import { isHttpUrl } from '../utils/validation.js';

export const LIMITS = Object.freeze({
  maxButtons: 100,
  maxPerRow: 8,
  maxLabel: 100,
  maxUrl: 2048,
  maxCallbackText: 200, // answerCallbackQuery text limit
});

const SEPARATOR = /\s+-\s+/g;

/** Colour names users may write, mapped to Telegram's native button styles. */
export const COLOUR_STYLES = Object.freeze({
  red: 'danger', blue: 'primary', green: 'success',
  danger: 'danger', primary: 'primary', success: 'success',
});
const COLOUR_RE = /^\s*=\s*([A-Za-z]+)/;

/** Cheap pre-check used to decide whether a line is *meant* to be a button row (a colour may follow the ")"). */
export function looksLikeButtonLine(line) {
  const t = String(line ?? '').trim();
  return t.startsWith('(') && /\)(\s*=\s*[A-Za-z]+)?$/.test(t) && /\s-\s/.test(t);
}

/**
 * Parse one button body (the text between the outer parentheses).
 * Returns { button } or { error }.
 */
export function parseButtonBody(body) {
  const text = String(body ?? '').trim();
  if (/^-(\s|$)/.test(text)) return { error: 'the button label is empty' };
  const seps = [...text.matchAll(SEPARATOR)];
  if (seps.length === 0) return { error: 'missing " - " between the button label and its link or text' };

  // 1) URL button: last separator, right side must be a valid http(s) URL.
  const last = seps[seps.length - 1];
  const right = text.slice(last.index + last[0].length).trim();
  const leftOfLast = text.slice(0, last.index).trim();
  if (/^https?:\/\//i.test(right)) {
    if (!isHttpUrl(right, LIMITS.maxUrl)) return { error: `"${shorten(right)}" is not a valid http(s) URL` };
    if (!leftOfLast) return { error: 'the button label is empty' };
    if (leftOfLast.length > LIMITS.maxLabel) return { error: `the label is longer than ${LIMITS.maxLabel} characters` };
    return { button: { text: leftOfLast, url: right } };
  }
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(right) && !/\s/.test(right)) {
    return { error: `"${shorten(right)}" looks like a link but has no http:// or https:// prefix` };
  }

  // 2) Callback button: split on the FIRST separator so the pop-up text may itself contain " - ".
  const first = seps[0];
  const label = text.slice(0, first.index).trim();
  const popup = text.slice(first.index + first[0].length).trim();
  if (!label) return { error: 'the button label is empty' };
  if (!popup) return { error: 'the callback text after " - " is empty' };
  if (label.length > LIMITS.maxLabel) return { error: `the label is longer than ${LIMITS.maxLabel} characters` };
  if (popup.length > LIMITS.maxCallbackText) {
    return { error: `the callback text is ${popup.length} characters; Telegram allows at most ${LIMITS.maxCallbackText}` };
  }
  return { button: { text: label, callback: popup } };
}

function shorten(s, n = 40) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Parse a single row such as "(A - x) | (B - y)". Returns { buttons, errors }. */
function parseRow(line, lineNo) {
  const buttons = [];
  const errors = [];
  const err = (message) => errors.push({ line: lineNo, message });
  let i = 0;
  let expectButton = true;
  let sawPipe = false;

  while (i < line.length) {
    const ch = line[i];
    if (/\s/.test(ch)) { i++; continue; }

    if (ch === '|') {
      if (expectButton) { err(buttons.length ? 'two "|" separators in a row (empty button slot)' : 'a row cannot start with "|"'); }
      expectButton = true;
      sawPipe = true;
      i++;
      continue;
    }

    if (ch === '(') {
      if (!expectButton) { err('missing "|" between two buttons'); }
      let depth = 0;
      let j = i;
      for (; j < line.length; j++) {
        if (line[j] === '(') depth++;
        else if (line[j] === ')') { depth--; if (depth === 0) break; }
      }
      if (depth !== 0) { err('unbalanced parentheses — every "(" needs a matching ")"'); return { buttons, errors }; }
      const parsed = parseButtonBody(line.slice(i + 1, j));
      i = j + 1;
      // Optional colour right after the ")": "= red", "= blue" or "= green".
      const colour = COLOUR_RE.exec(line.slice(i));
      let style = null;
      if (colour) {
        style = COLOUR_STYLES[colour[1].toLowerCase()] || null;
        if (!style) err(`Button ${buttons.length + 1}: unknown colour "${colour[1]}" (use red, blue or green)`);
        i += colour[0].length;
      }
      if (parsed.error) err(`Button ${buttons.length + 1}: ${parsed.error}`);
      else buttons.push(style ? { ...parsed.button, style } : parsed.button);
      expectButton = false;
      sawPipe = false;
      continue;
    }

    // Anything else outside parentheses is not allowed.
    err(`unexpected text "${shorten(line.slice(i).trim(), 30)}" outside of a (button)`);
    return { buttons, errors };
  }

  if (sawPipe && expectButton) err('the row ends with "|" but no button follows it');
  if (buttons.length > LIMITS.maxPerRow) err(`a row can hold at most ${LIMITS.maxPerRow} buttons`);
  return { buttons, errors };
}

/**
 * Parse a full button block. Blank lines are ignored; every other line is one keyboard row.
 * Returns { ok, rows, errors, buttonCount }. `ok` is false when any definition is malformed,
 * in which case callers should show formatParseErrors(errors) and NOT send a partial keyboard.
 */
export function parseButtons(input) {
  const rows = [];
  const errors = [];
  let buttonCount = 0;
  const lines = String(input ?? '').split(/\r?\n/);

  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    const { buttons, errors: rowErrors } = parseRow(line, idx + 1);
    errors.push(...rowErrors);
    if (buttons.length) { rows.push(buttons); buttonCount += buttons.length; }
  });

  if (buttonCount > LIMITS.maxButtons) errors.push({ line: 0, message: `too many buttons (${buttonCount}); Telegram allows ${LIMITS.maxButtons}` });
  if (rows.length === 0 && errors.length === 0) errors.push({ line: 0, message: 'no buttons found' });

  return { ok: errors.length === 0, rows, errors, buttonCount };
}

/**
 * Split a message into plain text + a trailing block of button rows.
 * Only a trailing run of lines that look like button rows is treated as buttons, so ordinary text
 * (including parenthesised sentences) is never turned into buttons by accident.
 *
 * Returns { found, textEnd, blockStart, rows, errors, ok }
 *   textEnd    - index where the message text ends (exclusive, trailing whitespace trimmed)
 *   blockStart - index where the button block starts (-1 when none)
 */
export function extractButtons(text) {
  const source = String(text ?? '');
  const lines = source.split('\n');
  const offsets = [];
  let pos = 0;
  for (const l of lines) { offsets.push(pos); pos += l.length + 1; }

  let i = lines.length - 1;
  let first = -1;
  while (i >= 0) {
    const t = lines[i].trim();
    if (t === '') { i--; continue; }
    if (looksLikeButtonLine(t)) { first = i; i--; continue; }
    break;
  }

  if (first === -1) return { found: false, textEnd: source.trimEnd().length, blockStart: -1, rows: [], errors: [], ok: true };

  const blockStart = offsets[first];
  const parsed = parseButtons(source.slice(blockStart));
  // Parse errors keep their line numbers relative to the block; shift them to the full text.
  const errors = parsed.errors.map((e) => ({ ...e, line: e.line ? e.line + first : e.line }));
  return {
    found: true,
    textEnd: source.slice(0, blockStart).trimEnd().length,
    blockStart,
    rows: parsed.rows,
    errors,
    ok: parsed.ok,
  };
}

/** Human-readable error list for Telegram (plain text; escape before sending as HTML). */
export function formatParseErrors(errors) {
  return errors
    .slice(0, 8)
    .map((e) => (e.line ? `• Line ${e.line}: ${e.message}` : `• ${e.message}`))
    .join('\n') + (errors.length > 8 ? `\n• …and ${errors.length - 8} more` : '');
}

export const BUTTON_FORMAT_HELP = [
  '(Label - https://example.com)  →  link button',
  '(Label - Any text)  →  pop-up button',
  '(A - https://a.com) | (B - https://b.com)  →  same row',
  '(Label - https://example.com) = green  →  coloured: red, blue or green',
  'New line  →  new row',
].join('\n');
