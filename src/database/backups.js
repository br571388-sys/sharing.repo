// backup_logs table.

import { nowSec } from '../utils/helpers.js';

export async function logBackup(db, { type, scope = 'global', ownerId = null, groupChatId = null, location = null, status = 'success', sizeBytes = null, error = null }) {
  const res = await db.execute(
    `INSERT INTO backup_logs (backup_type, scope, owner_id, group_id, backup_location, status, size_bytes, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [type, scope, ownerId, groupChatId, location, status, sizeBytes, error ? String(error).slice(0, 500) : null, nowSec()],
  );
  return res.lastInsertRowid;
}

export function lastBackup(db, { type = null, status = null } = {}) {
  const where = [];
  const args = [];
  if (type) { where.push('backup_type = ?'); args.push(type); }
  if (status) { where.push('status = ?'); args.push(status); }
  return db.first(`SELECT * FROM backup_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 1`, args);
}

export function recentBackups(db, limit = 5) {
  return db.all('SELECT * FROM backup_logs ORDER BY id DESC LIMIT ?', [limit]);
}

export async function backupCounts(db) {
  const row = await db.first(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS ok,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
     FROM backup_logs`,
  );
  return { total: Number(row.total), ok: Number(row.ok), failed: Number(row.failed) };
}
