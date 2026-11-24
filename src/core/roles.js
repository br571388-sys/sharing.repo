// Three-level role hierarchy, resolved ONLY from trusted records:
//   owner  = configured OWNER_ID            (highest authority, cannot be changed from inside the bot)
//   sudo   = rows in the sudo_users table   (added by the owner; always below the owner)
//   user   = everyone else
// Role information supplied by a user (message text, callback payloads) is never used.

import { isBotOwner } from './permissions.js';
import { isSudoUser } from '../database/roles.js';

export const ROLE = Object.freeze({ OWNER: 'owner', SUDO: 'sudo', USER: 'user' });

/** Resolves a Telegram user id to a role. Memoised per request context. */
export async function getRole(ctx, userId) {
  if (userId === undefined || userId === null) return ROLE.USER;
  if (isBotOwner(ctx.config, userId)) return ROLE.OWNER;
  const cache = (ctx._roleCache ||= new Map());
  const key = Number(userId);
  if (!cache.has(key)) cache.set(key, (await isSudoUser(ctx.db, key).catch(() => false)) ? ROLE.SUDO : ROLE.USER);
  return cache.get(key);
}

export const isOwnerRole = (role) => role === ROLE.OWNER;
export const isModeratorRole = (role) => role === ROLE.OWNER || role === ROLE.SUDO;

/** Drops a memoised role (after /sudo add|remove in the same request). */
export function forgetRole(ctx, userId) {
  ctx._roleCache?.delete(Number(userId));
}
