// Maintenance mode: when the Main Owner turns it on in /panel, the bot answers only the owner.
// Everyone else gets a short notice in private chats and nothing in groups.
import { getBotSetting } from '../database/settings.js';
import { isBotOwner } from './permissions.js';
import { box } from '../ui/design.js';

export const MAINTENANCE_TEXT = 'The bot is under maintenance right now. Please try again a little later.';

/** Returns true when the update was answered with the maintenance notice (and must not be processed further). */
export async function maintenanceBlocks(ctx, update) {
  if ((await getBotSetting(ctx.db, 'maintenance', '0')) !== '1') return false;
  const from = update.callback_query?.from ?? update.message?.from ?? update.edited_message?.from ?? update.my_chat_member?.from ?? update.chat_member?.from ?? null;
  if (from && isBotOwner(ctx.config, from.id)) return false;
  if (update.callback_query) {
    await ctx.tg.answerCallbackQuery(update.callback_query.id, MAINTENANCE_TEXT, true).catch(() => {});
    return true;
  }
  const chat = update.message?.chat ?? update.edited_message?.chat ?? null;
  if (chat?.type === 'private') await ctx.tg.sendMessage(chat.id, `${box('🛠', 'Under Maintenance')}\n\n${MAINTENANCE_TEXT}`).catch(() => {});
  return Boolean(from || chat);
}
