import { queueLog, who } from '../../core/activityLog.js';
// /sudo — the main owner manages sudo moderators (rank below the owner).
//   /sudo add USER_ID | /sudo remove USER_ID | /sudo list   (reply to a user also works for add/remove)
// Role data lives in the sudo_users table; the owner is always config.OWNER_ID and can never be demoted.

import { addSudoUser, listSudoUsers, logAudit, removeSudoUser } from '../../database/roles.js';
import { forgetRole } from '../../core/roles.js';
import { isBotOwner } from '../../core/permissions.js';
import { btn, closeBtn, markup } from '../../keyboards/inlineKeyboard.js';
import { box, row } from '../../ui/design.js';
import { esc, messages } from '../../utils/formatter.js';
import { reply } from '../../handlers/helpers.js';
import { formatDateTimeIST } from '../../services/timezone.js';
import { logger } from '../../utils/logger.js';
import { personHtml, personInfo } from './people.js';

const ID_RE = /^\d{1,15}$/;

/** Gives / takes the moderator command menu (best effort: the person must have opened the bot once). */
export async function setModeratorMenu(ctx, userId, on) {
  try {
    const scope = { type: 'chat', chat_id: Number(userId) };
    if (on) {
      const { menuCommands } = await import('../../handlers/commands.js');
      await ctx.tg.setMyCommands(menuCommands('sudo'), scope);
    } else {
      await ctx.tg.call('deleteMyCommands', { scope });
    }
  } catch (e) { logger.warn('moderator menu update failed', { error: e?.message }); }
}

const LIST_SHOWN = 10;

export async function sudoListText(ctx) {
  const list = await listSudoUsers(ctx.db);
  const shown = list.slice(0, LIST_SHOWN);
  const more = list.length > LIST_SHOWN ? `\n… and ${list.length - LIST_SHOWN} more — open <b>🛡 Panel</b> to page through them.` : '';
  const lines = list.length
    ? (await Promise.all(shown.map(async (u, i) => `<b>${i + 1}.</b> ${personHtml(await personInfo(ctx, u.user_id), u.user_id)}\n   <i>added ${formatDateTimeIST(Number(u.added_at))}</i>`))).join('\n') + more
    : 'No sudo moderators yet.';
  return `${box('🛡', 'Sudo Moderators')}\n\n${row('👑', 'Main owner', `<code>${ctx.config.ownerId}</code>`, { raw: true })}\n${row('📊', 'Sudo moderators', String(list.length))}\n\n${lines}\n\n💡 <i>/sudo add USER_ID · /sudo remove USER_ID</i>`;
}

export async function sudoCommand(ctx, msg, args = '') {
  // Defence in depth: the command table already restricts /sudo to the owner.
  if (!isBotOwner(ctx.config, msg.from?.id)) return reply(ctx, msg, messages.denied('Only the main owner can manage sudo moderators.'));
  const [sub = 'list', ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const action = sub.toLowerCase();

  if (action === 'list' || !args.trim()) return reply(ctx, msg, await sudoListText(ctx), { reply_markup: markup([[btn('🛡 Panel', 'pn:sd:0'), closeBtn()]]) });

  if (action !== 'add' && action !== 'remove' && action !== 'rm') {
    return reply(ctx, msg, messages.usage(['/sudo add USER_ID', '/sudo remove USER_ID', '/sudo list'], ['/sudo add 123456789']));
  }
  const repliedUser = msg.reply_to_message?.from;
  const raw = rest[0];
  const id = raw !== undefined ? (ID_RE.test(raw) ? Number(raw) : NaN) : repliedUser?.id;
  if (!Number.isInteger(id) || id <= 0) return reply(ctx, msg, messages.warning('Invalid User ID', 'Give a numeric Telegram user ID, or reply to the user. Example: /sudo add 123456789'));
  if (repliedUser?.is_bot && raw === undefined) return reply(ctx, msg, messages.warning('Not Allowed', 'A bot cannot be a sudo moderator.'));

  if (action === 'add') {
    if (isBotOwner(ctx.config, id)) return reply(ctx, msg, messages.warning('Already The Owner', 'The main owner already has every permission.'));
    const added = await addSudoUser(ctx.db, id, msg.from.id);
    if (!added) return reply(ctx, msg, messages.warning('Already Sudo', `User ${id} is already a sudo moderator.`));
    forgetRole(ctx, id);
    await logAudit(ctx.db, { actor: msg.from.id, action: 'sudo_add', target: id });
    queueLog(ctx, `🛡 <b>sudo added</b> <code>${id}</code> · by ${who(msg.from)}`);
    await setModeratorMenu(ctx, id, true);
    await ctx.tg.sendMessage(id, `${box('🎉', 'Moderator Access')}\n\nYou were made a sudo moderator of <b>${esc(ctx.config.botName)}</b>. Send /start to open your moderator panel.`).catch(() => {});
    const person = await personInfo(ctx, id);
    return reply(ctx, msg, `${box('✅', 'Sudo Moderator Added')}\n\n${row('👤', 'User', personHtml(person, id), { raw: true })}\n${row('🛡', 'Rank', 'Sudo moderator (below the owner)')}`, { reply_markup: markup([[btn('🛡 Panel', 'pn:sd:0'), closeBtn()]]) });
  }

  const removed = await removeSudoUser(ctx.db, id);
  if (!removed) return reply(ctx, msg, messages.warning('Not A Sudo Moderator', `User ${id} is not a sudo moderator.`));
  forgetRole(ctx, id);
  await logAudit(ctx.db, { actor: msg.from.id, action: 'sudo_remove', target: id });
  queueLog(ctx, `🛡 <b>sudo removed</b> <code>${id}</code> · by ${who(msg.from)}`);
  await setModeratorMenu(ctx, id, false);
  const gone = await personInfo(ctx, id);
  return reply(ctx, msg, `${box('✅', 'Sudo Moderator Removed')}\n\n${row('👤', 'User', personHtml(gone, id), { raw: true })}\nThey no longer have moderator access.`, { reply_markup: markup([[closeBtn()]]) });
}
