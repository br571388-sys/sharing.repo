// Turns a Telegram user ID into "Name (@username) · ID" so moderators recognise people in lists and buttons.
// Looks in the bot's own user table first, then asks Telegram; unknown people fall back to the ID alone.

import { esc } from '../../utils/formatter.js';

export async function personInfo(ctx, id) {
  let name = '';
  let username = '';
  try {
    const u = await ctx.db.first('SELECT first_name, last_name, username FROM users WHERE telegram_user_id = ?', [Number(id)]);
    if (u) {
      name = [u.first_name, u.last_name].filter(Boolean).join(' ');
      username = u.username || '';
    }
  } catch { /* table always exists; keep going */ }
  if (!name) {
    try {
      const c = await ctx.tg.getChat(Number(id));
      name = [c?.first_name, c?.last_name].filter(Boolean).join(' ');
      username = username || c?.username || '';
    } catch { /* Telegram does not reveal this user to the bot */ }
  }
  return { name, username };
}

/** HTML for lists: "Name (@username) · 123456". */
export function personHtml(p, id) {
  const who = p.name ? esc(p.name) : 'Unknown name';
  return `${who}${p.username ? ` (@${esc(p.username)})` : ''} · <code>${id}</code>`;
}

/** Short text for buttons: the first name, else the ID. */
export function personButton(p, id) {
  const first = String(p.name || '').split(' ')[0];
  return (first || String(id)).slice(0, 18);
}
