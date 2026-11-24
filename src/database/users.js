// users table.

import { nowSec } from '../utils/helpers.js';

/** Registers or refreshes a user from a Telegram `from` object. Returns { user, isNew }. */
export async function upsertUser(db, from) {
  const id = Number(from.id);
  const existing = await db.first('SELECT * FROM users WHERE telegram_user_id = ?', [id]);
  const now = nowSec();
  if (existing) {
    const changed = existing.username !== (from.username ?? null) || existing.first_name !== (from.first_name ?? null)
      || existing.last_name !== (from.last_name ?? null) || existing.is_blocked;
    if (changed) {
      await db.execute(
        'UPDATE users SET username = ?, first_name = ?, last_name = ?, language_code = ?, is_blocked = 0, updated_at = ? WHERE telegram_user_id = ?',
        [from.username ?? null, from.first_name ?? null, from.last_name ?? null, from.language_code ?? null, now, id],
      );
    }
    await touchLastSeen(db, id, now);
    return { user: { ...existing, username: from.username ?? null, first_name: from.first_name ?? null, is_blocked: 0 }, isNew: false };
  }
  await db.execute(
    `INSERT INTO users (telegram_user_id, username, first_name, last_name, language_code, is_blocked, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?) ON CONFLICT(telegram_user_id) DO NOTHING`,
    [id, from.username ?? null, from.first_name ?? null, from.last_name ?? null, from.language_code ?? null, now, now],
  );
  await touchLastSeen(db, id, now);
  const user = await db.first('SELECT * FROM users WHERE telegram_user_id = ?', [id]);
  return { user, isNew: true };
}

/** Records when the user last interacted (used for activity statistics). Never throws. */
export async function touchLastSeen(db, id, now) {
  await db.execute('UPDATE users SET last_seen_at = ? WHERE telegram_user_id = ?', [now, id]).catch(() => {});
}

export function getUser(db, telegramUserId) {
  return db.first('SELECT * FROM users WHERE telegram_user_id = ?', [Number(telegramUserId)]);
}

export async function setUserBlocked(db, telegramUserId, blocked) {
  await db.execute('UPDATE users SET is_blocked = ?, updated_at = ? WHERE telegram_user_id = ?', [blocked ? 1 : 0, nowSec(), Number(telegramUserId)]);
}

export async function countUsers(db) {
  const row = await db.first('SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN is_blocked = 0 THEN 1 ELSE 0 END), 0) AS active FROM users');
  return { total: Number(row.total), active: Number(row.active) };
}
