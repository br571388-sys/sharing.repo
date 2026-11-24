// Known group members: everyone the bot has seen speak or join in a group. Telegram does not let bots list all
// members, so /all and /atag mention these people. Stored per group in group_members.
import { nowSec } from '../../utils/helpers.js';

/** Records the sender of a group message (and anyone who joined with them). Bots are never stored. */
export async function rememberMembers(ctx, msg) {
  if (!msg?.chat || (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup')) return;
  const people = [];
  if (msg.from && !msg.from.is_bot) people.push(msg.from);
  for (const u of msg.new_chat_members || []) if (!u.is_bot) people.push(u);
  const now = nowSec();
  for (const u of people.slice(0, 20)) {
    await ctx.db.execute(
      `INSERT INTO group_members (chat_id, user_id, username, first_name, is_bot, last_seen, left_at) VALUES (?, ?, ?, ?, 0, ?, NULL)
       ON CONFLICT(chat_id, user_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name, last_seen = excluded.last_seen, left_at = NULL`,
      [Number(msg.chat.id), Number(u.id), u.username || null, String(u.first_name || '').slice(0, 64), now],
    );
  }
}

/** A member left: they stay in history but are no longer mentioned. */
export async function forgetLeftMember(ctx, msg) {
  const u = msg?.left_chat_member;
  if (!u || u.is_bot || !msg?.chat) return;
  await ctx.db.execute('UPDATE group_members SET left_at = ? WHERE chat_id = ? AND user_id = ?', [nowSec(), Number(msg.chat.id), Number(u.id)]);
}

/** Active (not left) human members the bot knows in this group. */
export async function knownMembers(ctx, chatId, limit = 300) {
  return ctx.db.all(
    'SELECT user_id, username, first_name FROM group_members WHERE chat_id = ? AND left_at IS NULL ORDER BY last_seen DESC LIMIT ?',
    [Number(chatId), limit],
  );
}
