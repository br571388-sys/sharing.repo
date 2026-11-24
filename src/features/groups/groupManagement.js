import { queueLog } from '../../core/activityLog.js';
import { esc as escLog } from '../../ui/escape.js';
// Group lifecycle + group-specific administration: registration, ownership, authorised administrators.
// Every group is stored under its own telegram_chat_id; nothing here reads or writes another group's rows.

import { addGroupAdmin, claimGroupWelcome, getGroup, listGroupAdmins, migrateGroupChatId, removeGroupAdmin, setGroupActive, setGroupOwner, upsertGroup } from '../../database/groups.js';
import { Role, getMemberStatus, isBotOwner, resolveAuthority } from '../../core/permissions.js';
import { esc, field, messages, mention } from '../../utils/formatter.js';
import { reply } from '../../handlers/helpers.js';
import { sendGroupWelcome } from '../start/start.js';
import { formatDateTimeIST } from '../../services/timezone.js';
import { logger } from '../../utils/logger.js';
import { isNumericId } from '../../utils/validation.js';
import { boxHtml } from '../../ui/design.js';
import { queueActiveGbansForGroup } from '../roles/gban.js';

/** Finds the real creator through Telegram. Returns user id or null (anonymous / unreadable). */
export async function detectGroupCreator(ctx, chatId) {
  try {
    const admins = await ctx.tg.getChatAdministrators(chatId);
    const creator = admins.find((a) => a.status === 'creator');
    return creator?.user && !creator.user.is_bot ? creator.user.id : null;
  } catch {
    return null;
  }
}

/** Register (or refresh) a group the bot is in, identifying its owner from Telegram when possible. */
export async function registerGroup(ctx, chat) {
  const existing = await getGroup(ctx.db, chat.id);
  const creatorId = existing?.owner_user_id && existing.owner_source === 'telegram' ? null : await detectGroupCreator(ctx, chat.id);
  return upsertGroup(ctx.db, chat, creatorId ? { ownerUserId: creatorId, ownerSource: 'telegram' } : {});
}

/** The bot was added to a group (new_chat_members or my_chat_member). Sends ONE welcome per group. */
export async function onBotAdded(ctx, chat) {
  const { group } = await registerGroup(ctx, chat);
  await queueActiveGbansForGroup(ctx, chat.id).catch(() => {});
  queueLog(ctx, `➕ bot added to <b>${escLog(chat.title || String(chat.id))}</b> <code>${chat.id}</code>`);
  if (await claimGroupWelcome(ctx.db, chat.id)) {
    try { await sendGroupWelcome(ctx, chat); } catch (e) { logger.warn('group welcome failed', { error: e?.message }); }
  }
  return group;
}

export async function onBotRemoved(ctx, chat) {
  await setGroupActive(ctx.db, chat.id, false);
  queueLog(ctx, `➖ bot removed from <b>${escLog(chat.title || String(chat.id))}</b> <code>${chat.id}</code>`);
}

export async function onGroupMigrated(ctx, oldId, newId) {
  await migrateGroupChatId(ctx.db, oldId, newId);
}

const needGroup = (ctx, msg) => (msg.chat.type === 'group' || msg.chat.type === 'supergroup') ? null : reply(ctx, msg, messages.groupOnly());

/** /registerowner — explicit ownership registration when Telegram cannot tell us who created the group. */
export async function registerOwnerCommand(ctx, msg) {
  const early = needGroup(ctx, msg); if (early) return early;
  const group = (await getGroup(ctx.db, msg.chat.id)) || (await registerGroup(ctx, msg.chat)).group;
  const member = await getMemberStatus(ctx, msg.chat.id, msg.from.id);

  if (member?.status === 'creator') {
    await setGroupOwner(ctx.db, msg.chat.id, msg.from.id, 'telegram');
    return reply(ctx, msg, messages.success('Owner Verified', 'Telegram confirms you created this group. You are registered as the group owner.'));
  }
  if (member?.status !== 'administrator' || !member.can_promote_members) {
    return reply(ctx, msg, messages.denied('Only an administrator with the “Add new admins” right can register as owner.'));
  }
  if (group.owner_user_id && group.owner_source === 'telegram') {
    return reply(ctx, msg, messages.warning('Owner Already Verified', 'This group already has an owner confirmed by Telegram.'));
  }
  if (group.owner_user_id && Number(group.owner_user_id) !== msg.from.id) {
    const current = await getMemberStatus(ctx, msg.chat.id, group.owner_user_id);
    if (current?.status === 'administrator' || current?.status === 'creator') {
      return reply(ctx, msg, messages.warning('Owner Already Registered', 'A registered owner is still an administrator of this group.'));
    }
  }
  await setGroupOwner(ctx.db, msg.chat.id, msg.from.id, 'registered');
  return reply(ctx, msg, messages.success('Owner Registered', 'You are now registered as this group\'s owner for backups and restores.'));
}

async function resolveTarget(ctx, msg, args) {
  const replied = msg.reply_to_message?.from;
  if (replied && !replied.is_bot) return replied.id;
  const word = args.trim().split(/\s+/)[0];
  return isNumericId(word) && !word.startsWith('-') ? Number(word) : null; // only a *target*, never proof of identity
}

/** /authorize (reply or user id) — group owner lets another current admin back up / restore this group. */
export async function authorizeCommand(ctx, msg, args) {
  const early = needGroup(ctx, msg); if (early) return early;
  const authority = await resolveAuthority(ctx, msg.chat, msg.from.id);
  if (authority.role !== Role.GROUP_OWNER && !authority.isBotOwner) return reply(ctx, msg, messages.denied('Only the group owner can authorise administrators.'));
  const target = await resolveTarget(ctx, msg, args);
  if (!target) return reply(ctx, msg, messages.usage(['/authorize (reply to an admin)', '/authorize <user id>']));
  const member = await getMemberStatus(ctx, msg.chat.id, target);
  if (member?.status !== 'administrator' && member?.status !== 'creator') {
    return reply(ctx, msg, messages.warning('Not an Administrator', 'Only current group administrators can be authorised.'));
  }
  await addGroupAdmin(ctx.db, authority.group, target, msg.from.id);
  return reply(ctx, msg, messages.success('Administrator Authorised', 'They can now create and restore backups for this group.'));
}

export async function unauthorizeCommand(ctx, msg, args) {
  const early = needGroup(ctx, msg); if (early) return early;
  const authority = await resolveAuthority(ctx, msg.chat, msg.from.id);
  if (authority.role !== Role.GROUP_OWNER && !authority.isBotOwner) return reply(ctx, msg, messages.denied('Only the group owner can remove authorisations.'));
  const target = await resolveTarget(ctx, msg, args);
  if (!target) return reply(ctx, msg, messages.usage(['/unauthorize (reply to an admin)', '/unauthorize <user id>']));
  const removed = await removeGroupAdmin(ctx.db, authority.group, target);
  return reply(ctx, msg, removed ? messages.success('Authorisation Removed', 'That administrator can no longer back up or restore this group.') : messages.warning('Not Authorised', 'That user was not an authorised administrator.'));
}

/** /groupinfo — registration, ownership and authorised admins of THIS group. */
export async function groupInfoCommand(ctx, msg) {
  const early = needGroup(ctx, msg); if (early) return early;
  const group = (await getGroup(ctx.db, msg.chat.id)) || (await registerGroup(ctx, msg.chat)).group;
  const admins = await listGroupAdmins(ctx.db, group);
  const ownerLine = group.owner_user_id
    ? `${mention(group.owner_user_id, 'Owner')} <i>(${group.owner_source === 'telegram' ? 'verified by Telegram' : 'registered'})</i>`
    : '<i>not identified — an admin can run /registerowner</i>';
  return reply(ctx, msg, [
    '👥 <b>Group Info</b>', '',
    field('📌', 'Title', group.title || '—'),
    field('🆔', 'Chat ID', group.telegram_chat_id),
    field('👑', 'Owner', ownerLine, { raw: true }),
    field('🛡', 'Authorised admins', admins.length),
    field('📅', 'Registered', formatDateTimeIST(group.joined_at)),
  ].join('\n'));
}

/** /groupadmins — list authorised administrators. */
export async function groupAdminsCommand(ctx, msg) {
  const early = needGroup(ctx, msg); if (early) return early;
  const group = (await getGroup(ctx.db, msg.chat.id)) || (await registerGroup(ctx, msg.chat)).group;
  const admins = await listGroupAdmins(ctx.db, group);
  if (!admins.length) return reply(ctx, msg, `${boxHtml("🛡", "Authorised Administrators")}\n\nNone yet. The group owner can add some with /authorize.`);
  return reply(ctx, msg, `${boxHtml("🛡", "Authorised Administrators")}\n\n${admins.map((a, i) => `${i + 1}. ${mention(a.telegram_user_id, `User ${a.telegram_user_id}`)}`).join('\n')}`);
}

export { esc, isBotOwner };
