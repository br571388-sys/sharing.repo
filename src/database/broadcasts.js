// broadcast_jobs + broadcast_logs.
// The recipient list is snapshotted into broadcast_logs when the job is created, so a job is fully described
// by database rows and can always be resumed. UNIQUE(job_id, chat_id) makes duplicate deliveries impossible.

import { nowSec } from '../utils/helpers.js';

export const TARGETS = ['users', 'groups', 'all'];
export const SENT = 'sent';
export const FAILED_STATUSES = ['failed', 'blocked', 'unknown'];

export async function createJob(db, { createdBy, targetType, payload, progressChatId = null }) {
  const now = nowSec();
  const res = await db.execute(
    `INSERT INTO broadcast_jobs (created_by, target_type, message_payload, status, progress_chat_id, created_at, updated_at)
     VALUES (?, ?, ?, 'preparing', ?, ?, ?)`,
    [Number(createdBy), targetType, JSON.stringify(payload), progressChatId, now, now],
  );
  const jobId = res.lastInsertRowid;

  const statements = [];
  if (targetType === 'users' || targetType === 'all') {
    statements.push({
      sql: `INSERT OR IGNORE INTO broadcast_logs (job_id, chat_id, chat_type, delivery_status, created_at, updated_at)
            SELECT ?, telegram_user_id, 'user', 'pending', ?, ? FROM users WHERE is_blocked = 0`,
      args: [jobId, now, now],
    });
  }
  if (targetType === 'groups' || targetType === 'all') {
    statements.push({
      sql: `INSERT OR IGNORE INTO broadcast_logs (job_id, chat_id, chat_type, delivery_status, created_at, updated_at)
            SELECT ?, telegram_chat_id, 'group', 'pending', ?, ? FROM groups WHERE is_active = 1`,
      args: [jobId, now, now],
    });
  }
  statements.push({
    sql: `UPDATE broadcast_jobs SET total_recipients = (SELECT COUNT(*) FROM broadcast_logs WHERE job_id = ?),
            status = CASE WHEN (SELECT COUNT(*) FROM broadcast_logs WHERE job_id = ?) = 0 THEN 'completed' ELSE 'queued' END,
            completed_at = CASE WHEN (SELECT COUNT(*) FROM broadcast_logs WHERE job_id = ?) = 0 THEN ? ELSE NULL END,
            updated_at = ? WHERE id = ?`,
    args: [jobId, jobId, jobId, now, now, jobId],
  });
  await db.batch(statements);
  return getJob(db, jobId);
}

export async function getJob(db, id) {
  const job = await db.first('SELECT * FROM broadcast_jobs WHERE id = ?', [Number(id)]);
  if (!job) return null;
  let payload = null;
  try { payload = JSON.parse(job.message_payload); } catch { payload = null; }
  return { ...job, payload };
}

export async function countRecipients(db, targetType) {
  let users = 0;
  let groups = 0;
  if (targetType === 'users' || targetType === 'all') users = Number(await db.value('SELECT COUNT(*) FROM users WHERE is_blocked = 0', [], 0));
  if (targetType === 'groups' || targetType === 'all') groups = Number(await db.value('SELECT COUNT(*) FROM groups WHERE is_active = 1', [], 0));
  return { users, groups, total: users + groups };
}

export async function setJobStatus(db, id, status, extra = {}) {
  const now = nowSec();
  const completed = ['completed', 'cancelled', 'failed'].includes(status) ? now : null;
  await db.execute(
    'UPDATE broadcast_jobs SET status = ?, updated_at = ?, completed_at = COALESCE(?, completed_at), last_error = COALESCE(?, last_error) WHERE id = ?',
    [status, now, completed, extra.error ?? null, Number(id)],
  );
}

export async function touchJob(db, id) {
  await db.execute('UPDATE broadcast_jobs SET updated_at = ? WHERE id = ?', [nowSec(), Number(id)]);
}

/** Atomically claims up to `limit` pending rows (pending -> sending). A row can only be claimed once. */
export async function claimBatch(db, jobId, limit) {
  const now = nowSec();
  const res = await db.execute(
    `UPDATE broadcast_logs SET delivery_status = 'sending', attempts = attempts + 1, updated_at = ?
     WHERE id IN (SELECT id FROM broadcast_logs WHERE job_id = ? AND delivery_status = 'pending' ORDER BY id LIMIT ?)
     RETURNING id, chat_id, chat_type, attempts`,
    [now, Number(jobId), limit],
  );
  return res.rows;
}

export async function markResults(db, results) {
  if (!results.length) return;
  const now = nowSec();
  await db.batch(results.map((r) => ({
    sql: 'UPDATE broadcast_logs SET delivery_status = ?, error_message = ?, updated_at = ? WHERE id = ?',
    args: [r.status, r.error ? String(r.error).slice(0, 300) : null, now, r.id],
  })));
}

/**
 * Rows stuck in 'sending' (worker died mid-send) cannot be retried without risking a duplicate message,
 * so they become 'unknown' and count as failed. Returns how many were converted.
 */
export async function settleStaleSending(db, jobId, olderThanSec = 300) {
  const now = nowSec();
  const res = await db.execute(
    `UPDATE broadcast_logs SET delivery_status = 'unknown', error_message = 'Interrupted before delivery was confirmed (not retried to avoid duplicates)', updated_at = ?
     WHERE job_id = ? AND delivery_status = 'sending' AND updated_at < ?`,
    [now, Number(jobId), now - olderThanSec],
  );
  return res.rowsAffected;
}

export async function jobStats(db, jobId) {
  const rows = await db.all('SELECT delivery_status AS s, COUNT(*) AS n FROM broadcast_logs WHERE job_id = ? GROUP BY delivery_status', [Number(jobId)]);
  const by = Object.fromEntries(rows.map((r) => [r.s, Number(r.n)]));
  const sent = by.sent || 0;
  const failed = (by.failed || 0) + (by.blocked || 0) + (by.unknown || 0);
  const pending = by.pending || 0;
  const sending = by.sending || 0;
  return { sent, failed, blocked: by.blocked || 0, pending, sending, total: sent + failed + pending + sending, by };
}

export async function refreshCounters(db, jobId) {
  const s = await jobStats(db, jobId);
  await db.execute(
    'UPDATE broadcast_jobs SET successful_count = ?, failed_count = ?, updated_at = ? WHERE id = ?',
    [s.sent, s.failed, nowSec(), Number(jobId)],
  );
  return s;
}

export async function markProgressMessage(db, jobId, chatId, messageId) {
  await db.execute('UPDATE broadcast_jobs SET progress_chat_id = ?, progress_message_id = ?, progress_updated_at = ? WHERE id = ?', [chatId, messageId, nowSec(), Number(jobId)]);
}

export async function touchProgress(db, jobId) {
  await db.execute('UPDATE broadcast_jobs SET progress_updated_at = ? WHERE id = ?', [nowSec(), Number(jobId)]);
}

/** Jobs that should be moving but have not made progress recently (worker crash / lost queue message). */
export function listStaleJobs(db, olderThanSec = 180) {
  return db.all(
    `SELECT id, status, updated_at FROM broadcast_jobs WHERE status IN ('queued', 'running') AND updated_at < ? ORDER BY id LIMIT 20`,
    [nowSec() - olderThanSec],
  );
}

export async function failStalePreparing(db, olderThanSec = 600) {
  const res = await db.execute(
    `UPDATE broadcast_jobs SET status = 'failed', last_error = 'Job was never fully prepared', completed_at = ?, updated_at = ?
     WHERE status = 'preparing' AND created_at < ?`,
    [nowSec(), nowSec(), nowSec() - olderThanSec],
  );
  return res.rowsAffected;
}

export async function broadcastTotals(db) {
  const row = await db.first(
    `SELECT COUNT(*) AS jobs, COALESCE(SUM(successful_count), 0) AS ok, COALESCE(SUM(failed_count), 0) AS failed,
            COALESCE(SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END), 0) AS active
     FROM broadcast_jobs`,
  );
  return { jobs: Number(row.jobs), ok: Number(row.ok), failed: Number(row.failed), active: Number(row.active) };
}

export function recentJobs(db, limit = 5) {
  return db.all('SELECT id, target_type, status, total_recipients, successful_count, failed_count, created_at FROM broadcast_jobs ORDER BY id DESC LIMIT ?', [limit]);
}
