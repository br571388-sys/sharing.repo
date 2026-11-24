// /getid <user id | channel id | @username> (owner and sudo users): profile or channel link for an ID.

import { btn, closeBtn, markup, urlBtn } from '../../keyboards/inlineKeyboard.js';
import { getRole, isModeratorRole } from '../../core/roles.js';
import { logger } from '../../utils/logger.js';
import { box, row } from '../../ui/design.js';
import { esc, messages } from '../../utils/formatter.js';
import { reply } from '../../handlers/helpers.js';

const ID_RE = /^-?\d{5,16}$/;
const USERNAME_RE = /^@?([A-Za-z][A-Za-z0-9_]{4,31})$/;
const KIND = { private: 'User', channel: 'Channel', group: 'Group', supergroup: 'Supergroup', bot: 'Bot' };

/** Creates an invite link through the bot itself. Works only when the bot is an admin with "Invite users". */
async function botInviteLink(ctx, chatId) {
  const me = await ctx.tg.getMe();
  const m = await ctx.tg.getChatMember(chatId, me.id);
  const isAdmin = m?.status === 'creator' || (m?.status === 'administrator' && m.can_invite_users);
  if (!isAdmin) return { error: 'The bot must be an admin with the "Invite users" right in this chat to create a link.' };
  const inv = await ctx.tg.createChatInviteLink(chatId, { name: 'Nobara lookup' });
  return { link: inv.invite_link };
}

export async function getidCommand(ctx, msg, args = '') {
  const raw = String(args || '').trim();
  const isId = ID_RE.test(raw);
  const userMatch = raw.match(USERNAME_RE);
  if (!raw || (!isId && !userMatch)) {
    return reply(ctx, msg, messages.usage(
      ['/getid <user id | channel id | @username>'],
      ['/getid 123456789', '/getid -1001234567890', '/getid @durov'],
      'Works for users who have talked to the bot or share a chat with it, and for public or bot-admin chats.',
    ));
  }

  let chat;
  try {
    chat = await ctx.tg.getChat(isId ? Number(raw) : `@${userMatch[1]}`);
  } catch {
    return reply(ctx, msg, messages.warning('Not Found', 'Telegram did not reveal this ID to the bot. It works only for users who have talked to the bot or share a chat with it, and for public chats.'));
  }

  const id = chat.id;
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.title || 'Unknown';
  const username = chat.username || '';
  const isUser = chat.type === 'private';
  const kind = KIND[chat.type] || 'Chat';

  let link = '';        // https link: shown as a button and as text
  let linkLabel = '';
  let note = '';

  if (username) {
    link = `https://t.me/${username}`;
    linkLabel = isUser ? '👤 Open Profile' : '🔗 Open Link';
  } else if (isUser) {
    note = 'This user has no username. Tap Open Profile to open the profile.';
  } else {
    try {
      const made = await botInviteLink(ctx, id);
      if (made.link) { link = made.link; linkLabel = '🔗 Join Link'; note = 'Invite link created by the bot. Anyone with it can join.'; }
      else note = made.error;
    } catch {
      note = 'Could not create an invite link. The bot must be an admin with the "Invite users" right.';
    }
  }

  const lines = [
    row('🏷', 'Type', kind),
    row('📛', 'Name', esc(name), { raw: true }),
    row('🆔', 'ID', `<code>${id}</code>`, { raw: true }),
    row('🔗', 'Username', username ? `@${esc(username)}` : 'none', { raw: true }),
    row('🌐', 'Link', link ? `<code>${esc(link)}</code>` : 'not available', { raw: true }),
  ];
  const text = `${box('🔎', 'Lookup')}\n\n${lines.join('\n')}${note ? `\n\n<blockquote>${esc(note)}</blockquote>` : ''}`;
  // Try the URL button first (tg://user for users without a username). If Telegram refuses the message,
  // retry with a callback button (pop-up profile), and finally send the card without buttons.
  const variants = [];
  if (link) variants.push([urlBtn(linkLabel, link, { style: 'primary' })]);
  if (isUser && !username) {
    variants.push([urlBtn('👤 Open Profile', `tg://user?id=${id}`, { style: 'primary' })]);
    variants.push([btn('👤 Open Profile', `gi:p:${id}`, { style: 'primary' })]);
  }
  for (const first of variants) {
    try {
      return await reply(ctx, msg, text, { reply_markup: markup([first, [closeBtn()]]) });
    } catch (e) {
      logger.warn('getid card refused with buttons, retrying', { error: e?.message });
    }
  }
  return reply(ctx, msg, text, { reply_markup: markup([[closeBtn()]]) });
}
/** Tap on "Open Profile" for a user without a username. Re-checks owner/sudo, then opens the profile as a pop-up. */
export async function getidCallback(ctx, cq) {
  const role = await getRole(ctx, cq.from.id);
  if (!isModeratorRole(role)) return ctx.tg.answerCallbackQuery(cq.id, '🔒 Owner and sudo users only.', true);
  const id = Number(String(cq.data || '').split(':')[2]);
  if (!Number.isSafeInteger(id)) return ctx.tg.answerCallbackQuery(cq.id, 'Invalid ID.', true);
  try {
    await ctx.tg.answerCallbackQuery(cq.id, undefined, false, { url: `tg://user?id=${id}` });
  } catch (e) {
    logger.warn('getid profile link refused by Telegram', { error: e?.message });
    await ctx.tg.answerCallbackQuery(cq.id, `User ID: ${id}. Telegram cannot search by ID. Ask for their @username, or find them in a group you share.`, true);
  }
  return undefined;
}
