// bot_settings, user_settings, group_settings and group_data. Group data is always keyed by the internal
// group id, so one group can never read or write another group's records.

import { nowSec } from '../utils/helpers.js';

// ---- bot settings ----
export async function getBotSetting(db, key, fallback = null) {
  const row = await db.first('SELECT setting_value FROM bot_settings WHERE setting_key = ?', [key]);
  return row ? row.setting_value : fallback;
}

export async function setBotSetting(db, key, value) {
  await db.execute(
    `INSERT INTO bot_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`,
    [key, value === null || value === undefined ? null : String(value), nowSec()],
  );
}

export async function deleteBotSetting(db, key) {
  await db.execute('DELETE FROM bot_settings WHERE setting_key = ?', [key]);
}

// ---- user settings ----
export async function getUserSetting(db, telegramUserId, key, fallback = null) {
  const row = await db.first(
    'SELECT s.setting_value FROM user_settings s JOIN users u ON u.id = s.user_id WHERE u.telegram_user_id = ? AND s.setting_key = ?',
    [Number(telegramUserId), key],
  );
  return row ? row.setting_value : fallback;
}

export async function setUserSetting(db, telegramUserId, key, value) {
  await db.execute(
    `INSERT INTO user_settings (user_id, setting_key, setting_value, updated_at)
     SELECT id, ?, ?, ? FROM users WHERE telegram_user_id = ?
     ON CONFLICT(user_id, setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`,
    [key, value === null ? null : String(value), nowSec(), Number(telegramUserId)],
  );
}

// ---- group settings ----
export async function getGroupSetting(db, group, key, fallback = null) {
  const row = await db.first('SELECT setting_value FROM group_settings WHERE group_id = ? AND setting_key = ?', [group.id, key]);
  return row ? row.setting_value : fallback;
}

export async function setGroupSetting(db, group, key, value) {
  await db.execute(
    `INSERT INTO group_settings (group_id, setting_key, setting_value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(group_id, setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`,
    [group.id, key, value === null ? null : String(value), nowSec()],
  );
}

export function listGroupSettings(db, group) {
  return db.all('SELECT setting_key, setting_value FROM group_settings WHERE group_id = ? ORDER BY setting_key', [group.id]);
}

export async function deleteGroupSetting(db, group, key) {
  const res = await db.execute('DELETE FROM group_settings WHERE group_id = ? AND setting_key = ?', [group.id, key]);
  return res.rowsAffected > 0;
}

// ---- group data (free-form records per group) ----
export async function setGroupData(db, group, type, key, value) {
  const now = nowSec();
  await db.execute(
    `INSERT INTO group_data (group_id, data_type, data_key, data_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_id, data_type, data_key) DO UPDATE SET data_value = excluded.data_value, updated_at = excluded.updated_at`,
    [group.id, type, key, typeof value === 'string' ? value : JSON.stringify(value), now, now],
  );
}

export async function getGroupData(db, group, type, key) {
  const row = await db.first('SELECT data_value FROM group_data WHERE group_id = ? AND data_type = ? AND data_key = ?', [group.id, type, key]);
  return row ? row.data_value : null;
}

export function listGroupData(db, group, type) {
  return db.all('SELECT data_key, data_value FROM group_data WHERE group_id = ? AND data_type = ? ORDER BY data_key', [group.id, type]);
}

export async function deleteGroupData(db, group, type, key) {
  const res = await db.execute('DELETE FROM group_data WHERE group_id = ? AND data_type = ? AND data_key = ?', [group.id, type, key]);
  return res.rowsAffected > 0;
}
