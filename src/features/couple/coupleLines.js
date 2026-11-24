// Owner's editor for the /mypartner trolling lines (stored in bot_settings.couple_trolls as a JSON array).
// Lines are HTML-escaped when saved, because /mypartner sends them as HTML.
import { btn, markup, backCloseRow } from '../../keyboards/inlineKeyboard.js';
import { blockquote, box } from '../../ui/design.js';
import { esc } from '../../utils/formatter.js';
import { isBotOwner } from '../../core/permissions.js';
import { createPending, deletePendingForUser, getPendingForUser, takePending } from '../../database/state.js';
import { getBotSetting, setBotSetting } from '../../database/settings.js';
import { reply } from '../../handlers/helpers.js';
import { DEFAULT_TROLLS } from './couple.js';

const MAX_LINE = 200;
const MAX_LINES = 60;

export async function currentTrolls(db) {
  const raw = await getBotSetting(db, 'couple_trolls', '');
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.length) return { lines: parsed, custom: true };
  } catch { /* fall back to the defaults */ }
  return { lines: DEFAULT_TROLLS, custom: false };
}

export async function coupleLinesScreen(ctx) {
  const { lines, custom } = await currentTrolls(ctx.db);
  const preview = lines.slice(0, 3).map((l, i) => `${i + 1}. ${l}`).join('\n');
  const text = `${box('💘', 'Couple Trolling Lines')}\n\n${blockquote(`📋 Lines: ${lines.length}\n📌 Source: ${custom ? 'Your custom list' : 'Built-in default'}\n\n${preview}`)}\n\n<i>Shown by /mypartner when a couple is not selected yet.</i>`;
  const rows = [
    [btn('➕ Add a line', 'tl:a', { style: 'success' })],
    [btn('♻️ Reset to default', 'tl:r', { style: 'danger' })],
    backCloseRow('pn:ct'),
  ];
  return { text, keyboard: markup(rows) };
}

/** Owner pressed "Add a line": the owner's next private message becomes the line. */
export async function startAddLine(ctx, cq) {
  await deletePendingForUser(ctx.db, 'troll_line', cq.from.id);
  await createPending(ctx.db, { kind: 'troll_line', userId: cq.from.id, chatId: cq.message.chat.id, payload: {}, ttlSec: 600 });
  return ctx.tg.editMessageText(cq.message.chat.id, cq.message.message_id, `${box('➕', 'Send The New Line')}\n\n${blockquote(`Send one line of text (up to ${MAX_LINE} characters). It is saved right away.`)}`, {
    reply_markup: markup([[btn('❌ Cancel', 'tl:v', { style: 'danger' })]]),
  }).catch(() => {});
}

/** Private text from the owner while an "add line" is waiting. Returns true when it was used. */
export async function handleTrollLineMessage(ctx, msg) {
  if (!isBotOwner(ctx.config, msg.from.id)) return false;
  const pending = await getPendingForUser(ctx.db, 'troll_line', msg.from.id);
  if (!pending) return false;
  if (typeof msg.text !== 'string' || msg.text.startsWith('/')) return false;
  const line = msg.text.trim();
  if (!line.length || line.length > MAX_LINE) {
    await reply(ctx, msg, `${box('⚠️', 'Line Not Saved')}\n\n${blockquote(`Send 1 to ${MAX_LINE} characters.`)}`);
    return true;
  }
  const { lines } = await currentTrolls(ctx.db);
  if (lines.length >= MAX_LINES) {
    await takePending(ctx.db, pending.id, 'troll_line');
    await reply(ctx, msg, `${box('⚠️', 'Limit Reached')}\n\n${blockquote(`You can have up to ${MAX_LINES} lines. Reset to default or edit the list first.`)}`);
    return true;
  }
  await setBotSetting(ctx.db, 'couple_trolls', JSON.stringify([...lines, esc(line)]));
  await takePending(ctx.db, pending.id, 'troll_line');
  await reply(ctx, msg, `${box('✅', 'Line Saved')}\n\n${blockquote(`Total lines now: ${lines.length + 1}`)}`);
  return true;
}

export async function coupleLinesCallback(ctx, cq, parts) {
  if (!isBotOwner(ctx.config, cq.from.id)) return ctx.tg.answerCallbackQuery(cq.id, 'Only the Main Owner can change these lines.', true);
  const show = async (toast = '') => {
    const s = await coupleLinesScreen(ctx);
    await ctx.tg.editMessageText(cq.message.chat.id, cq.message.message_id, s.text, { reply_markup: s.keyboard }).catch(() => {});
    return ctx.tg.answerCallbackQuery(cq.id, toast, false);
  };
  switch (parts[1]) {
    case 'v': return show();
    case 'a': await startAddLine(ctx, cq); return ctx.tg.answerCallbackQuery(cq.id, 'Send the new line in the chat.', false);
    case 'r': {
      await setBotSetting(ctx.db, 'couple_trolls', '');
      return show('Reset to the built-in lines.');
    }
    default: return ctx.tg.answerCallbackQuery(cq.id, 'Unknown button.', true);
  }
}
