// Button design system. Telegram's Bot API supports a per-button `style` ("primary" = blue, "success" = green,
// "danger" = red) on inline keyboard buttons; clients that do not understand it show the normal grey button.
// Everything here is presentation only: callback_data / urls are never touched.

import { buttonLabel } from './typography.js';
import { normalizePlain } from './typography.js';

const state = { styles: true, fancy: true };

/** Called once from the config loader (UI_BUTTON_STYLES / UI_FANCY_BUTTONS). */
export function configureUi({ styles, fancy } = {}) {
  if (typeof styles === 'boolean') state.styles = styles;
  if (typeof fancy === 'boolean') state.fancy = fancy;
}
export const uiOptions = () => ({ ...state });

// Colour rules: red = close/cancel/delete/ban/dangerous, green = confirm/add/enable/success,
// blue = commands/navigation/info/dashboard, no style = ordinary settings buttons.
const DANGER = /(^|[^a-z])(close|cancel|dismiss|delete|remove|ban|unban sender|gban|reset|clear|abort|stop|purge)([^a-z]|$)|[❌✖🛑🗑]/iu;
const SUCCESS = /(^|[^a-z])(confirm|yes|send now|resolve|human|add|approve|accept|enable|save|done)([^a-z]|$)|✅/iu;
const PRIMARY = /^(?:\p{Extended_Pictographic}|️|\s)*(commands?|help( & commands)?|help center|about|updates?|developer|home|back|next|prev|refresh|panel|dashboard|[a-z ]*stats|recent activity|sudo management|undo[a-z ]*|[◀▶️ ]*(back|next|prev)[◀▶️ ]*)\s*$/iu;

/** Picks a style from the label. Order matters: destructive wins over "yes" (e.g. "Yes, delete all"). */
export function inferStyle(label) {
  const plain = normalizePlain(label);
  if (DANGER.test(plain)) return 'danger';
  if (SUCCESS.test(plain)) return 'success';
  if (PRIMARY.test(plain)) return 'primary';
  return undefined;
}

/**
 * Decorates a bot-owned button: premium label typography + colour. `opts.plain` keeps the label untouched
 * (dynamic text such as anime titles, numbers or user data); `opts.style` forces a style ('none' disables it).
 */
export function decorate(button, opts = {}) {
  const out = { ...button };
  if (state.fancy && !opts.plain) out.text = buttonLabel(button.text);
  if (state.styles) {
    const style = opts.style === 'none' ? undefined : (opts.style || inferStyle(button.text));
    if (style) out.style = style;
  }
  return out;
}
