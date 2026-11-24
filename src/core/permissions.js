// Centralised permission system. Permissions always come from the real Telegram sender id and, for groups,
// from Telegram's current chat-member status — never from text typed by the user.

import { canBroadcast, canUsePerm, captainPerms } from './captains.js';
import { getGroup, isAuthorizedGroupAdmin, setGroupOwner, upsertGroup } from '../database/groups.js';
import { isSudoUser } from '../database/roles.js';

export const ANONYMOUS_ADMIN_BOT_ID = 1087968824; // @GroupAnonymousBot

export const Role = Object.freeze({
  BOT_OWNER: 'bot_owner',
  GROUP_OWNER: 'group_owner',
  AUTHORIZED_ADMIN: 'authorized_admin',
  ADMIN: 'admin',
  MEMBER: 'member',
});

export function isBotOwner(config, userId) {
  return config.ownerId !== null && userId !== undefined && userId !== null && Number(userId) === config.ownerId;
}

/** The real sender of a message, or null when it cannot be verified (anonymous admins, channels). */
export function senderOf(message) {
  const from = message?.from;
  if (!from || from.id === ANONYMOUS_ADMIN_BOT_ID || from.is_bot) return null;
  if (message.sender_chat && message.sender_chat.id !== from.id) return null;
  return from;
}

const isGroup = (chat) => chat && (chat.type === 'group' || chat.type === 'supergroup');

/** Current member record from Telegram, or null if it cannot be read. */
export async function getMemberStatus(ctx, chatId, userId) {
  try {
    return await ctx.tg.getChatMember(chatId, userId);
  } catch {
    return null;
  }
}

/**
 * Resolves what `userId` is allowed to do in `chat`.
 * Returns { role, isBotOwner, status, group, canManage, canAnnounce }.
 *  - canAnnounce: any current administrator/creator (or the bot owner)
 *  - canManage:   group owner, explicitly authorised admin, or bot owner (backup/restore/settings)
 */
export async function resolveAuthority(ctx, chat, userId) {
  const owner = isBotOwner(ctx.config, userId);
  const base = { role: Role.MEMBER, isBotOwner: owner, status: 'none', group: null, canManage: owner, canAnnounce: owner };

  if (!isGroup(chat)) return { ...base, role: owner ? Role.BOT_OWNER : Role.MEMBER };

  let group = await getGroup(ctx.db, chat.id);
  if (!group) group = (await upsertGroup(ctx.db, chat)).group;

  const member = await getMemberStatus(ctx, chat.id, userId);
  const status = member?.status || 'none';
  let role = Role.MEMBER;

  if (status === 'creator') {
    role = Role.GROUP_OWNER;
    // Telegram is the source of truth: keep our record in sync if ownership was transferred.
    if (Number(group.owner_user_id) !== Number(userId)) {
      await setGroupOwner(ctx.db, chat.id, Number(userId), 'telegram');
      group = { ...group, owner_user_id: Number(userId), owner_source: 'telegram' };
    }
  } else if (status === 'administrator') {
    if (Number(group.owner_user_id) === Number(userId) && group.owner_source === 'registered') role = Role.GROUP_OWNER;
    else if (await isAuthorizedGroupAdmin(ctx.db, group, userId)) role = Role.AUTHORIZED_ADMIN;
    else role = Role.ADMIN;
  }

  const isAdminish = status === 'creator' || status === 'administrator';
  return {
    role: owner ? Role.BOT_OWNER : role,
    groupRole: role,
    isBotOwner: owner,
    status,
    group,
    canManage: owner || role === Role.GROUP_OWNER || role === Role.AUTHORIZED_ADMIN,
    canAnnounce: owner || isAdminish,
    isAdmin: isAdminish,
  };
}

/**
 * Access levels used by the command table and the help menu:
 *   public      everyone
 *   owner       bot owner only
 *   groupAdmin  group administrators (or bot owner) — group chats
 *   groupManage group owner / authorised admins (or bot owner) — group chats
 *   backup      bot owner in private chats, group managers in groups
 *   sudo        bot owner or a sudo moderator (global moderation: /panel, /gban …)
 */
export async function hasAccess(ctx, access, message) {
  const chat = message.chat;
  const sender = senderOf(message);
  const userId = sender?.id;

  if (access === 'public') return { ok: true };
  if (!sender) return { ok: false, reason: 'anonymous' };
  if (access === 'owner') return { ok: isBotOwner(ctx.config, userId), reason: 'owner' };
  // 'sudo' = moderator commands: the Main Owner or a sudo moderator stored in the database (never a typed-in role).
  if (access === 'sudo') return { ok: isBotOwner(ctx.config, userId) || (await isSudoUser(ctx.db, userId).catch(() => false)), reason: 'sudo' };
  // 'captain' = the Main Owner or a captain (a sudo user with broadcast rights).
  if (access === 'captain') return { ok: await canBroadcast(ctx, userId), reason: 'captain' };
  // 'groupMention' (/all, /atag) = the Main Owner, a sudo moderator, or in a group a group owner / administrator.
  if (access === 'groupMention') {
    if (isBotOwner(ctx.config, userId) || (await isSudoUser(ctx.db, userId).catch(() => false))) return { ok: true, reason: 'sudo' };
    if (!isGroup(message.chat)) return { ok: false, reason: 'group_only' };
    const authority = await resolveAuthority(ctx, message.chat, userId);
    return { ok: authority.canAnnounce, authority, reason: 'admin' };
  }
  // 'perm:<name>' = the owner, or a captain the owner gave that permission (see core/captains.js CAPTAIN_PERMS).
  if (access.startsWith('perm:')) return { ok: await canUsePerm(ctx, userId, access.slice(5)), reason: 'captain' };

  if (isBotOwner(ctx.config, userId) && access !== 'groupOnlyOwner') {
    return { ok: true, authority: { role: Role.BOT_OWNER, isBotOwner: true, canManage: true, canAnnounce: true } };
  }

  if (!isGroup(chat)) return { ok: false, reason: access === 'backup' ? 'owner' : 'group_only' };

  const authority = await resolveAuthority(ctx, chat, userId);
  if (access === 'groupAdmin') return { ok: authority.canAnnounce, authority, reason: 'admin' };
  if (access === 'groupManage' || access === 'backup') return { ok: authority.canManage, authority, reason: 'manage' };
  return { ok: false, reason: 'unknown' };
}

/** Which commands should the help menu show to this person here? */
export async function visibleAccessLevels(ctx, message) {
  const sender = senderOf(message);
  const levels = new Set(['public']);
  if (!sender) return levels;
  if (isBotOwner(ctx.config, sender.id)) {
    ['owner', 'sudo', 'backup', 'groupAdmin', 'groupManage', 'groupMention', 'perm:welcome', 'perm:buttons', 'perm:logs'].forEach((l) => levels.add(l));
    return levels;
  }
  if (await isSudoUser(ctx.db, sender.id).catch(() => false)) levels.add('sudo');
  for (const k of await captainPerms(ctx.db, sender.id)) levels.add(`perm:${k}`);
  if (isGroup(message.chat)) {
    const a = await resolveAuthority(ctx, message.chat, sender.id);
    if (a.canAnnounce) levels.add('groupAdmin');
    if (a.canAnnounce) levels.add('groupMention');
    if (a.canManage) { levels.add('groupManage'); levels.add('backup'); }
  }
  return levels;
}
