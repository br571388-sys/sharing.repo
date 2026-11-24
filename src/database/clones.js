// Clone registry (main database). Secrets are stored encrypted; this module only moves them, never reads them out to users.
import { nowSec } from '../utils/helpers.js';

const COLUMNS = `id, owner_user_id, bot_id, bot_username, bot_name, db_url, status, stopped_by, maintenance, broadcast_approved,
  webhook_fail_count, last_error, last_active_at, last_check_at, created_at, updated_at, removed_at`;

/** Public view of a clone (no secrets). */
export async function getClone(db, id) {
  return db.first(`SELECT ${COLUMNS} FROM clones WHERE id = ?`, [Number(id)]);
}

/** Full row including encrypted secrets; used only by the runtime and the health check. */
export async function getCloneSecrets(db, id) {
  return db.first('SELECT * FROM clones WHERE id = ?', [Number(id)]);
}

export async function listClones(db, ownerId = null) {
  if (ownerId === null) return db.all(`SELECT ${COLUMNS} FROM clones WHERE status != 'removed' ORDER BY id ASC`);
  return db.all(`SELECT ${COLUMNS} FROM clones WHERE owner_user_id = ? AND status != 'removed' ORDER BY id ASC`, [Number(ownerId)]);
}

export async function countOwnerClones(db, ownerId) {
  return Number(await db.value("SELECT COUNT(*) FROM clones WHERE owner_user_id = ? AND status != 'removed'", [Number(ownerId)], 0));
}

export async function botIdTaken(db, botId) {
  return Boolean(await db.first('SELECT id FROM clones WHERE bot_id = ?', [Number(botId)]));
}

export async function dbUrlTaken(db, url) {
  return Boolean(await db.first('SELECT id FROM clones WHERE db_url = ?', [url]));
}

export async function insertClone(db, row) {
  const now = nowSec();
  const res = await db.execute(
    `INSERT INTO clones (owner_user_id, bot_id, bot_username, bot_name, token_enc, db_url, db_token_enc, webhook_secret_enc, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    [Number(row.owner_user_id), Number(row.bot_id), row.bot_username || null, row.bot_name, row.token_enc, row.db_url, row.db_token_enc, row.webhook_secret_enc, now, now],
  );
  return Number(res.lastInsertRowid ?? res.lastInsertId ?? 0);
}

/** Updates the given columns only (names are fixed in code, never taken from users). */
export async function updateClone(db, id, fields) {
  const allowed = ['status', 'stopped_by', 'maintenance', 'broadcast_approved', 'webhook_fail_count', 'last_error', 'last_active_at', 'last_check_at', 'removed_at', 'token_enc', 'webhook_secret_enc', 'db_token_enc'];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!keys.length) return;
  await db.execute(`UPDATE clones SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...keys.map((k) => fields[k]), nowSec(), Number(id)]);
}

export async function logCloneNotification(db, { cloneId, ownerId, kind, ok, error = null }) {
  await db.execute(
    'INSERT INTO clone_notifications (clone_id, owner_user_id, kind, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [Number(cloneId), Number(ownerId), kind, ok ? 'sent' : 'failed', error ? String(error).slice(0, 200) : null, nowSec()],
  );
}

export async function cloneLimit(db) {
  return Number(await db.value("SELECT setting_value FROM bot_settings WHERE setting_key = 'clone_limit'", [], 1)) || 1;
}
