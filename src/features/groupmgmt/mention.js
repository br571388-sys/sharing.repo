// /all (every known member) and /atag (administrators only). Mentions go out in batches; when the command is a reply,
// every batch replies to that message so the context is kept.
import { esc, messages } from '../../utils/formatter.js';
import { reply } from '../../handlers/helpers.js';
import { sleep } from '../../utils/helpers.js';
import { knownMembers } from './members.js';
import { recordError } from '../../core/errorHandler.js';

const BATCH = 20;
const MAX_MENTIONS = 300;

/** @username when there is one; otherwise a text mention by user id, which works without a username. */
export function mentionOf(u) {
  if (u.username && /^[A-Za-z0-9_]{5,32}$/.test(u.username)) return `@${u.username}`;
  return `<a href="tg://user?id=${Number(u.user_id ?? u.id)}">${esc(String(u.first_name || 'Member').slice(0, 40))}</a>`;
}

async function administrators(ctx, chatId) {
  const list = await ctx.tg.call('getChatAdministrators', { chat_id: chatId });
  return (Array.isArray(list) ? list : [])
    .filter((m) => m.user && !m.user.is_bot)
    .map((m) => ({ user_id: m.user.id, username: m.user.username, first_name: m.user.first_name }));
}

async function sendMentions(ctx, msg, people, title) {
  const chatId = msg.chat.id;
  const replyTo = msg.reply_to_message?.message_id;
  const lines = people.map(mentionOf);
  for (let i = 0; i < lines.length; i += BATCH) {
    const batch = lines.slice(i, i + BATCH).join(' ');
    const head = i === 0 ? `${title}\n` : '';
    await ctx.tg.sendMessage(chatId, `${head}${batch}`, replyTo ? { reply_parameters: { message_id: replyTo } } : {});
    if (i + BATCH < lines.length) await sleep(1000); // stay well under Telegram's per-group send limit
  }
}

export async function allCommand(ctx, msg) {
  try {
    const people = (await knownMembers(ctx, msg.chat.id, MAX_MENTIONS)).filter((u) => !u.is_bot);
    if (!people.length) return reply(ctx, msg, messages.warning('No Members Yet', 'I have not seen any member of this group speak or join yet.'));
    await sendMentions(ctx, msg, people, '📣 <b>Attention everyone</b>');
    return undefined;
  } catch (e) {
    await recordError(ctx, 'all', e);
    return reply(ctx, msg, messages.warning('Not Sent', 'Telegram did not accept the mention message. Please try again.'));
  }
}

export async function atagCommand(ctx, msg) {
  try {
    const people = await administrators(ctx, msg.chat.id);
    if (!people.length) return reply(ctx, msg, messages.warning('No Administrators', 'Telegram did not return any administrators for this group.'));
    await sendMentions(ctx, msg, people, '🛡 <b>Attention admins</b>');
    return undefined;
  } catch (e) {
    await recordError(ctx, 'atag', e);
    return reply(ctx, msg, messages.warning('Not Sent', 'Telegram did not accept the mention message. Please try again.'));
  }
}
