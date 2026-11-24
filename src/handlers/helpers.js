// Small helpers used by every command handler.

import { isMessageNotModified } from '../services/telegram.js';

/** Reply to a message (threaded in groups, plain in private chats). */
export function reply(ctx, msg, text, extra = {}) {
  const isPrivate = msg.chat.type === 'private';
  return ctx.tg.sendMessage(msg.chat.id, text, {
    ...(isPrivate ? {} : { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } }),
    ...(msg.message_thread_id && msg.is_topic_message ? { message_thread_id: msg.message_thread_id } : {}),
    ...extra,
  });
}

/** Edit a message, ignoring "message is not modified". */
export async function safeEdit(ctx, chatId, messageId, text, extra = {}) {
  try {
    return await ctx.tg.editMessageText(chatId, messageId, text, extra);
  } catch (e) {
    if (isMessageNotModified(e)) return null;
    throw e;
  }
}

export async function safeEditCaption(ctx, chatId, messageId, caption, extra = {}) {
  try {
    return await ctx.tg.editMessageCaption(chatId, messageId, caption, extra);
  } catch (e) {
    if (isMessageNotModified(e)) return null;
    throw e;
  }
}

/** Reactions Telegram accepts for bots (a bot may only use these on messages). */
export const REACTION_POOL = ['👍', '🔥', '❤', '🎉', '⚡', '🤩', '😁', '👏'];

/** React to a successful command in private chats (best effort, configurable). Without an emoji a random one is used. */
export async function reactOk(ctx, msg, emoji = null, { anyChat = false } = {}) {
  if (!ctx.config.reactions || (!anyChat && msg.chat.type !== 'private')) return;
  const pick = emoji || REACTION_POOL[Math.floor(Math.random() * REACTION_POOL.length)];
  await ctx.tg.react(msg.chat.id, msg.message_id, pick);
}

/** Visible length of Telegram-HTML (tags removed, entities counted as one char). */
export function visibleLength(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|quot);/g, 'x').length;
}

export const displayName = (user) => [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.username || 'User';

export const isPrivateChat = (chat) => chat?.type === 'private';
export const isGroupChatType = (chat) => chat?.type === 'group' || chat?.type === 'supergroup';
