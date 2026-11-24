// Routes a Telegram update to the right handler.

import { handleMessage } from '../handlers/messages.js';
import { handleCallback } from '../handlers/callbacks.js';
import { setUserBlocked, upsertUser } from '../database/users.js';
import { onBotAdded, onBotRemoved } from '../features/groups/groupManagement.js';
import { safely } from './errorHandler.js';

export const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member'];

/** my_chat_member: the bot's own status changed in a chat (blocked/unblocked in private, added/removed in groups). */
async function handleMyChatMember(ctx, update) {
  const { chat, new_chat_member: next, old_chat_member: prev, from } = update;
  const status = next?.status;
  if (!chat || !status) return;

  if (chat.type === 'private') {
    if (status === 'kicked') await setUserBlocked(ctx.db, chat.id, true);
    else if (status === 'member' && from && !from.is_bot) await upsertUser(ctx.db, from);
    return;
  }
  if (chat.type === 'group' || chat.type === 'supergroup') {
    const wasIn = ['member', 'administrator'].includes(prev?.status);
    if (['member', 'administrator'].includes(status) && !wasIn) await onBotAdded(ctx, chat);
    else if (['left', 'kicked'].includes(status)) await onBotRemoved(ctx, chat);
  }
}

export async function routeUpdate(ctx, update) {
  if (update.message) return handleMessage(ctx, update.message);
  if (update.callback_query) return handleCallback(ctx, update.callback_query);
  if (update.my_chat_member) return safely(ctx, 'my_chat_member', null, () => handleMyChatMember(ctx, update.my_chat_member));
  return undefined; // edited messages, channel posts, etc. are intentionally ignored
}
