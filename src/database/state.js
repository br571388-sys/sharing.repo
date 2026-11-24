// Small operational tables: update de-duplication, pending confirmations, custom button callbacks,
// rate limits and the database-backed cache.

import { nowSec, randomToken } from '../utils/helpers.js';

// ---- update de-duplication ----
/** Returns true if this update id was NOT seen before (and records it). */
export async function claimUpdate(db, updateId) {
  const res = await db.execute('INSERT OR IGNORE INTO processed_updates (update_id, processed_at) VALUES (?, ?)', [Number(updateId), nowSec()]);
  return res.rowsAffected > 0;
}

export async function releaseUpdate(db, updateId) {
  await db.execute('DELETE FROM processed_updates WHERE update_id = ?', [Number(updateId)]);
}

// ---- pending confirmations (import / broadcast) ----
export async function createPending(db, { kind, userId, chatId, payload, ttlSec = 900 }) {
  const id = randomToken(9);
  const now = nowSec();
  await db.execute(
    'INSERT INTO pending_actions (id, kind, user_id, chat_id, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, kind, Number(userId), Number(chatId), JSON.stringify(payload), now, now + ttlSec],
  );
  return id;
}

export async function getPending(db, id, kind) {
  const row = await db.first('SELECT * FROM pending_actions WHERE id = ? AND kind = ? AND expires_at > ?', [id, kind, nowSec()]);
  if (!row) return null;
  return { ...row, payload: JSON.parse(row.payload) };
}

/** Atomically removes and returns a pending action so a confirmation can only run once. */
export async function takePending(db, id, kind) {
  const row = await getPending(db, id, kind);
  if (!row) return null;
  const res = await db.execute('DELETE FROM pending_actions WHERE id = ?', [id]);
  return res.rowsAffected > 0 ? row : null;
}

/** Replaces the payload of a live pending action (used to remember choices such as selected clone bots). */
export async function updatePendingPayload(db, id, payload) {
  await db.execute('UPDATE pending_actions SET payload = ? WHERE id = ?', [JSON.stringify(payload), id]);
}

export async function deletePending(db, id) {
  await db.execute('DELETE FROM pending_actions WHERE id = ?', [id]);
}

/** The newest live pending action of one kind for one user (used by the panel's "send message"). */
export async function getPendingForUser(db, kind, userId) {
  const row = await db.first('SELECT * FROM pending_actions WHERE kind = ? AND user_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1', [kind, Number(userId), nowSec()]);
  if (!row) return null;
  return { ...row, payload: JSON.parse(row.payload) };
}

export async function deletePendingForUser(db, kind, userId) {
  await db.execute('DELETE FROM pending_actions WHERE kind = ? AND user_id = ?', [kind, Number(userId)]);
}

// ---- custom callback buttons ----
export async function saveButtonCallbacks(db, entries) {
  if (!entries.length) return;
  const now = nowSec();
  await db.batch(entries.map((e) => ({
    sql: 'INSERT OR IGNORE INTO button_callbacks (id, text, created_at) VALUES (?, ?, ?)',
    args: [e.id, e.text, now],
  })));
}

export async function getButtonCallback(db, id) {
  const row = await db.first('SELECT text FROM button_callbacks WHERE id = ?', [id]);
  return row ? row.text : null;
}

// ---- rate limiting (fixed window) ----
/** Returns { allowed, retryAfter }. */
export async function hitRateLimit(db, key, limit, windowSec) {
  const now = nowSec();
  const row = await db.first('SELECT hits, reset_at FROM rate_limits WHERE rl_key = ?', [key]);
  if (!row || row.reset_at <= now) {
    await db.execute(
      'INSERT INTO rate_limits (rl_key, hits, reset_at) VALUES (?, 1, ?) ON CONFLICT(rl_key) DO UPDATE SET hits = 1, reset_at = excluded.reset_at',
      [key, now + windowSec],
    );
    return { allowed: true, retryAfter: 0 };
  }
  if (row.hits >= limit) return { allowed: false, retryAfter: row.reset_at - now };
  await db.execute('UPDATE rate_limits SET hits = hits + 1 WHERE rl_key = ?', [key]);
  return { allowed: true, retryAfter: 0 };
}

// ---- DB cache ----
export async function dbCacheGet(db, key) {
  const row = await db.first('SELECT cache_value FROM cache_entries WHERE cache_key = ? AND expires_at > ?', [key, nowSec()]);
  return row ? row.cache_value : null;
}

export async function dbCacheSet(db, key, value, ttlSec) {
  await db.execute(
    `INSERT INTO cache_entries (cache_key, cache_value, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET cache_value = excluded.cache_value, expires_at = excluded.expires_at`,
    [key, value, nowSec() + ttlSec],
  );
}

/** Housekeeping: drops expired rows. Returns counts removed. */
export async function purgeExpired(db) {
  const now = nowSec();
  const a = await db.execute('DELETE FROM cache_entries WHERE expires_at <= ?', [now]);
  const b = await db.execute('DELETE FROM pending_actions WHERE expires_at <= ?', [now]);
  const c = await db.execute('DELETE FROM processed_updates WHERE processed_at < ?', [now - 3 * 86400]);
  const d = await db.execute('DELETE FROM rate_limits WHERE reset_at <= ?', [now]);
  return { cache: a.rowsAffected, pending: b.rowsAffected, updates: c.rowsAffected, rateLimits: d.rowsAffected };
}
