// groups table + explicitly authorised group administrators.

import { nowSec } from '../utils/helpers.js';

export const isGroupChat = (chat) => chat && (chat.type === 'group' || chat.type === 'supergroup');

/**
 * Registers or refreshes a group. `ownerUserId` is only written when provided and the group has no owner yet
 * (or `forceOwner` is set), so a re-registration never silently changes who owns the group.
 */
export async function upsertGroup(db, chat, { ownerUserId = null, ownerSource = null, forceOwner = false } = {}) {
  const chatId = Number(chat.id);
  const now = nowSec();
  const existing = await db.first('SELECT * FROM groups WHERE telegram_chat_id = ?', [chatId]);
  if (!existing) {
    await db.execute(
      `INSERT INTO groups (telegram_chat_id, title, username, group_type, owner_user_id, owner_source, is_active, joined_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(telegram_chat_id) DO NOTHING`,
      [chatId, chat.title ?? null, chat.username ?? null, chat.type || 'group', ownerUserId, ownerUserId ? ownerSource : null, now, now],
    );
    const group = await db.first('SELECT * FROM groups WHERE telegram_chat_id = ?', [chatId]);
    return { group, isNew: true };
  }

  const setOwner = ownerUserId && (forceOwner || !existing.owner_user_id);
  await db.execute(
    `UPDATE groups SET title = ?, username = ?, group_type = ?, is_active = 1,
       owner_user_id = ?, owner_source = ?, updated_at = ? WHERE telegram_chat_id = ?`,
    [
      chat.title ?? existing.title, chat.username ?? null, chat.type || existing.group_type,
      setOwner ? ownerUserId : existing.owner_user_id, setOwner ? ownerSource : existing.owner_source, now, chatId,
    ],
  );
  const group = await db.first('SELECT * FROM groups WHERE telegram_chat_id = ?', [chatId]);
  return { group, isNew: false, reactivated: !existing.is_active };
}

export function getGroup(db, telegramChatId) {
  return db.first('SELECT * FROM groups WHERE telegram_chat_id = ?', [Number(telegramChatId)]);
}

export async function setGroupActive(db, telegramChatId, active) {
  await db.execute('UPDATE groups SET is_active = ?, updated_at = ? WHERE telegram_chat_id = ?', [active ? 1 : 0, nowSec(), Number(telegramChatId)]);
}

export async function setGroupOwner(db, telegramChatId, ownerUserId, source) {
  await db.execute('UPDATE groups SET owner_user_id = ?, owner_source = ?, updated_at = ? WHERE telegram_chat_id = ?', [ownerUserId, source, nowSec(), Number(telegramChatId)]);
}

/** Marks the welcome message as sent. Returns true only for the first caller (prevents duplicate welcomes). */
export async function claimGroupWelcome(db, telegramChatId) {
  const res = await db.execute('UPDATE groups SET welcome_sent_at = ? WHERE telegram_chat_id = ? AND welcome_sent_at IS NULL', [nowSec(), Number(telegramChatId)]);
  return res.rowsAffected > 0;
}

export async function migrateGroupChatId(db, oldChatId, newChatId) {
  await db.execute('UPDATE groups SET telegram_chat_id = ?, group_type = ?, updated_at = ? WHERE telegram_chat_id = ?', [Number(newChatId), 'supergroup', nowSec(), Number(oldChatId)]);
}

export async function countGroups(db) {
  const row = await db.first('SELECT COUNT(*) AS total, COALESCE(SUM(is_active), 0) AS active FROM groups');
  return { total: Number(row.total), active: Number(row.active) };
}

// --- authorised administrators (may back up / restore the group besides the owner) ---

export async function addGroupAdmin(db, group, telegramUserId, grantedBy) {
  await db.execute(
    'INSERT OR IGNORE INTO group_admins (group_id, telegram_user_id, granted_by, created_at) VALUES (?, ?, ?, ?)',
    [group.id, Number(telegramUserId), grantedBy ?? null, nowSec()],
  );
}

export async function removeGroupAdmin(db, group, telegramUserId) {
  const res = await db.execute('DELETE FROM group_admins WHERE group_id = ? AND telegram_user_id = ?', [group.id, Number(telegramUserId)]);
  return res.rowsAffected > 0;
}

export function listGroupAdmins(db, group) {
  return db.all('SELECT telegram_user_id, granted_by, created_at FROM group_admins WHERE group_id = ? ORDER BY created_at', [group.id]);
}

export async function isAuthorizedGroupAdmin(db, group, telegramUserId) {
  const row = await db.first('SELECT 1 AS ok FROM group_admins WHERE group_id = ? AND telegram_user_id = ?', [group.id, Number(telegramUserId)]);
  return Boolean(row);
}
