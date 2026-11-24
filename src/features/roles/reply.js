// Two-way messages between the owner and a moderator or user, started from the panel's "Send message".
// The owner's message carries a 💬 Reply button. Tapping it lets the recipient answer; their next message goes to the
// owner, with a ✉️ Reply button under it so the owner can answer back.
import { createPending, deletePendingForUser, getPendingForUser, takePending } from '../../database/state.js';
import { btn, markup } from '../../keyboards/inlineKeyboard.js';
import { esc, messages } from '../../utils/formatter.js';
import { reply } from '../../handlers/helpers.js';
import { blockquote, box } from '../../ui/design.js';
import { isBotOwner } from '../../core/permissions.js';
import { recordError } from '../../core/errorHandler.js';

const REPLY_TTL = 1800;

/** Keyboard under a message from the owner: the recipient taps it to answer. */
export const replyButtonMarkup = (ownerId) => markup([[btn('💬 Reply', `ur:${ownerId}`, { style: 'primary' })]]);

/** 💬 Reply tap (recipient): the next message from this person is forwarded to the owner. */
export async function userReplyCallback(ctx, cq, parts) {
  const owner = Number(parts[1]);
  if (!Number.isInteger(owner) || owner <= 0) return ctx.tg.answerCallbackQuery(cq.id, 'This button is no longer valid.', true);
  await deletePendingForUser(ctx.db, 'user_reply', cq.from.id);
  await createPending(ctx.db, { kind: 'user_reply', userId: cq.from.id, chatId: cq.message.chat.id, payload: { owner }, ttlSec: REPLY_TTL });
  await ctx.tg.sendMessage(cq.message.chat.id, `${box('💬', 'Send Your Message')}\n\n${blockquote('Type your message now. It goes straight to the owner. Anything works: text, photos, videos or files.')}`);
  return ctx.tg.answerCallbackQuery(cq.id, 'Send your message now.', false);
}

/** Forwards the recipient's reply to the owner. Returns true when the message was handled. */
export async function forwardUserReply(ctx, msg) {
  const pending = await getPendingForUser(ctx.db, 'user_reply', msg.from.id);
  if (!pending) return false;
  if (typeof msg.text === 'string' && msg.text.startsWith('/')) return false; // commands still run normally
  const owner = Number(pending.payload.owner);
  const name = esc(String(msg.from.first_name || 'User').slice(0, 40));
  try {
    await ctx.tg.sendMessage(owner, `💬 <b>Reply from</b> ${name} <code>${msg.from.id}</code>`, {
      reply_markup: markup([[btn('✉️ Reply', `ou:${msg.from.id}`, { style: 'primary' })]]),
    });
    await ctx.tg.call('copyMessage', { chat_id: owner, from_chat_id: msg.chat.id, message_id: msg.message_id });
  } catch (e) {
    await recordError(ctx, 'user reply', e);
    await reply(ctx, msg, messages.warning('Not Delivered', 'Your reply could not be delivered. Please try again later.'));
    return true;
  }
  await takePending(ctx.db, pending.id, 'user_reply');
  await reply(ctx, msg, messages.success('Reply Sent', 'The owner received your message.'));
  return true;
}

/** ✉️ Reply tap (owner only): the owner's next message goes to that person. */
export async function ownerReplyCallback(ctx, cq, parts) {
  if (!isBotOwner(ctx.config, cq.from.id)) return ctx.tg.answerCallbackQuery(cq.id, '🔒 Only the main owner can reply here.', true);
  const target = Number(parts[1]);
  if (!Number.isInteger(target) || target <= 0) return ctx.tg.answerCallbackQuery(cq.id, 'This button is no longer valid.', true);
  await deletePendingForUser(ctx.db, 'panel_msg', cq.from.id);
  await createPending(ctx.db, { kind: 'panel_msg', userId: cq.from.id, chatId: cq.message.chat.id, payload: { target }, ttlSec: 900 });
  await ctx.tg.sendMessage(cq.message.chat.id, `${box('✉️', 'Send Your Message')}\n\n${blockquote('Type your message now. It goes straight to this person.')}`);
  return ctx.tg.answerCallbackQuery(cq.id, 'Send your message now.', false);
}
