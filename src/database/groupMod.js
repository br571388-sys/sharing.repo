// Group-management storage: warnings, restrictions, moderation log, verifications, flood counters, reports,
// filters, notes, blacklist, greetings and scheduled deletions.
// EVERY query is keyed by the internal group id (derived from telegram_chat_id), so groups never see each other's rows.

import { nowSec } from '../utils/helpers.js';

// ---------------------------------------------------------------- moderation log
export async function logModeration(db, group, { action, target = null, moderator = null, reason = null, messageId = null, result = 'success', expiresAt = null }) {
  await db.execute(
    `INSERT INTO group_moderation_logs (group_id, action, target_user_id, moderator_id, reason, related_message_id, result, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [group.id, action, target, moderator, reason ? String(reason).slice(0, 500) : null, messageId, String(result).slice(0, 200), expiresAt, nowSec()],
  );
}

export function recentModerationLogs(db, group, { userId = null, limit = 10, offset = 0 } = {}) {
  return userId
    ? db.all('SELECT * FROM group_moderation_logs WHERE group_id = ? AND target_user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?', [group.id, Number(userId), limit, offset])
    : db.all('SELECT * FROM group_moderation_logs WHERE group_id = ? ORDER BY id DESC LIMIT ? OFFSET ?', [group.id, limit, offset]);
}

export async function countModerationLogs(db, group, userId = null) {
  return Number(userId
    ? await db.value('SELECT COUNT(*) FROM group_moderation_logs WHERE group_id = ? AND target_user_id = ?', [group.id, Number(userId)], 0)
    : await db.value('SELECT COUNT(*) FROM group_moderation_logs WHERE group_id = ?', [group.id], 0));
}

// ---------------------------------------------------------------- restrictions (bans / mutes)
export async function recordRestriction(db, group, { userId, kind, moderator, reason, expiresAt = null }) {
  // A new restriction of the same kind replaces the previous active one.
  await db.execute("UPDATE group_restrictions SET status = 'replaced' WHERE group_id = ? AND user_id = ? AND kind = ? AND status = 'active'", [group.id, Number(userId), kind]);
  await db.execute(
    'INSERT INTO group_restrictions (group_id, user_id, kind, moderator_id, reason, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [group.id, Number(userId), kind, moderator ?? null, reason ? String(reason).slice(0, 500) : null, nowSec(), expiresAt, 'active'],
  );
}

export async function liftRestriction(db, group, userId, kind) {
  const res = await db.execute("UPDATE group_restrictions SET status = 'lifted' WHERE group_id = ? AND user_id = ? AND kind = ? AND status = 'active'", [group.id, Number(userId), kind]);
  return res.rowsAffected;
}

export function activeRestriction(db, group, userId, kind) {
  return db.first("SELECT * FROM group_restrictions WHERE group_id = ? AND user_id = ? AND kind = ? AND status = 'active' ORDER BY id DESC LIMIT 1", [group.id, Number(userId), kind]);
}

/** Temporary restrictions whose time is up (Telegram lifts them itself; this marks them and lets the cron confirm). */
export function dueRestrictions(db, now = nowSec(), limit = 100) {
  return db.all(
    `SELECT r.*, g.telegram_chat_id FROM group_restrictions r JOIN groups g ON g.id = r.group_id
     WHERE r.status = 'active' AND r.expires_at IS NOT NULL AND r.expires_at <= ? ORDER BY r.expires_at LIMIT ?`,
    [now, limit],
  );
}

export async function markRestrictionExpired(db, id) {
  await db.execute("UPDATE group_restrictions SET status = 'expired' WHERE id = ? AND status = 'active'", [id]);
}

// ---------------------------------------------------------------- warnings
const liveWarn = '(expires_at IS NULL OR expires_at > ?)';

export async function addWarning(db, group, { userId, moderator, reason, expiresAt = null }) {
  const res = await db.execute(
    'INSERT INTO group_warnings (group_id, user_id, moderator_id, reason, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    [group.id, Number(userId), moderator ?? null, reason ? String(reason).slice(0, 500) : null, nowSec(), expiresAt],
  );
  return Number(res.lastInsertRowid);
}

export async function countWarnings(db, group, userId) {
  return Number(await db.value(`SELECT COUNT(*) FROM group_warnings WHERE group_id = ? AND user_id = ? AND ${liveWarn}`, [group.id, Number(userId), nowSec()], 0));
}

export function listWarnings(db, group, userId) {
  return db.all(`SELECT * FROM group_warnings WHERE group_id = ? AND user_id = ? AND ${liveWarn} ORDER BY id`, [group.id, Number(userId), nowSec()]);
}

/** Removes the most recent live warning. Returns true if one was removed. */
export async function removeLastWarning(db, group, userId) {
  const row = await db.first(`SELECT id FROM group_warnings WHERE group_id = ? AND user_id = ? AND ${liveWarn} ORDER BY id DESC LIMIT 1`, [group.id, Number(userId), nowSec()]);
  if (!row) return false;
  const res = await db.execute('DELETE FROM group_warnings WHERE id = ? AND group_id = ?', [row.id, group.id]);
  return res.rowsAffected > 0;
}

export async function removeWarningById(db, group, warnId) {
  const res = await db.execute('DELETE FROM group_warnings WHERE id = ? AND group_id = ?', [Number(warnId), group.id]);
  return res.rowsAffected > 0;
}

export async function resetWarnings(db, group, userId) {
  const res = await db.execute('DELETE FROM group_warnings WHERE group_id = ? AND user_id = ?', [group.id, Number(userId)]);
  return res.rowsAffected;
}

// ---------------------------------------------------------------- verifications (captcha)
export async function startVerification(db, group, { userId, messageId = null, answer = null, expiresAt }) {
  await db.execute(
    `INSERT INTO group_verifications (group_id, user_id, message_id, answer, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(group_id, user_id) DO UPDATE SET message_id = excluded.message_id, answer = excluded.answer, status = 'pending', created_at = excluded.created_at, expires_at = excluded.expires_at`,
    [group.id, Number(userId), messageId, answer, nowSec(), expiresAt],
  );
}

export function getVerification(db, group, userId) {
  return db.first('SELECT * FROM group_verifications WHERE group_id = ? AND user_id = ?', [group.id, Number(userId)]);
}

/** Atomically moves a pending verification to a final state. Returns true for the first caller only. */
export async function settleVerification(db, group, userId, status) {
  const res = await db.execute("UPDATE group_verifications SET status = ? WHERE group_id = ? AND user_id = ? AND status = 'pending'", [status, group.id, Number(userId)]);
  return res.rowsAffected > 0;
}

export function dueVerifications(db, now = nowSec(), limit = 50) {
  return db.all(
    `SELECT v.*, g.telegram_chat_id FROM group_verifications v JOIN groups g ON g.id = v.group_id
     WHERE v.status = 'pending' AND v.expires_at <= ? ORDER BY v.expires_at LIMIT ?`,
    [now, limit],
  );
}

// ---------------------------------------------------------------- flood / spam counters (persistent, no in-memory state)
/**
 * Counts one hit inside a sliding-start window and returns the new count. Atomic: one statement.
 * A window that has elapsed restarts at 1.
 */
export async function hitCounter(db, group, userId, kind, key, windowSec) {
  const now = nowSec();
  const res = await db.execute(
    `INSERT INTO group_flood_records (group_id, user_id, kind, rec_key, hits, window_start, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(group_id, user_id, kind, rec_key) DO UPDATE SET
       hits = CASE WHEN ? - window_start >= ? THEN 1 ELSE hits + 1 END,
       window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END,
       updated_at = ?
     RETURNING hits`,
    [group.id, Number(userId), kind, key, now, now, now, windowSec, now, windowSec, now, now],
  );
  return Number(res.rows[0]?.hits ?? 1);
}

export async function resetCounter(db, group, userId, kind, key = null) {
  if (key === null) await db.execute('DELETE FROM group_flood_records WHERE group_id = ? AND user_id = ? AND kind = ?', [group.id, Number(userId), kind]);
  else await db.execute('DELETE FROM group_flood_records WHERE group_id = ? AND user_id = ? AND kind = ? AND rec_key = ?', [group.id, Number(userId), kind, key]);
}

/** Group-wide counter (user id 0) used for join-rate / raid detection. */
export const hitGroupCounter = (db, group, kind, windowSec) => hitCounter(db, group, 0, kind, '', windowSec);

export async function clearGroupCounters(db, group, kind) {
  const res = await db.execute('DELETE FROM group_flood_records WHERE group_id = ? AND kind = ?', [group.id, kind]);
  return res.rowsAffected;
}

export async function purgeFloodRecords(db, olderThanSec = 3600) {
  const res = await db.execute('DELETE FROM group_flood_records WHERE updated_at < ?', [nowSec() - olderThanSec]);
  return res.rowsAffected;
}

// ---------------------------------------------------------------- reports
export async function createReport(db, group, { reporterId, reportedUserId, messageId, excerpt }) {
  const dup = await db.first("SELECT id FROM group_reports WHERE group_id = ? AND reported_message_id = ? AND status = 'open'", [group.id, messageId]);
  if (dup) return { id: Number(dup.id), duplicate: true };
  const res = await db.execute(
    'INSERT INTO group_reports (group_id, reporter_id, reported_user_id, reported_message_id, excerpt, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [group.id, Number(reporterId), reportedUserId ?? null, messageId, excerpt ? String(excerpt).slice(0, 300) : null, 'open', nowSec()],
  );
  return { id: Number(res.lastInsertRowid), duplicate: false };
}

export const getReport = (db, group, id) => db.first('SELECT * FROM group_reports WHERE id = ? AND group_id = ?', [Number(id), group.id]);
export const listOpenReports = (db, group, limit = 10) => db.all("SELECT * FROM group_reports WHERE group_id = ? AND status = 'open' ORDER BY id DESC LIMIT ?", [group.id, limit]);

/** Closes an open report. Returns true only for the first caller. */
export async function closeReport(db, group, id, status, by) {
  const res = await db.execute("UPDATE group_reports SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND group_id = ? AND status = 'open'", [status, by ?? null, nowSec(), Number(id), group.id]);
  return res.rowsAffected > 0;
}

export async function closeAllReports(db, group, by) {
  const res = await db.execute("UPDATE group_reports SET status = 'dismissed', resolved_by = ?, resolved_at = ? WHERE group_id = ? AND status = 'open'", [by ?? null, nowSec(), group.id]);
  return res.rowsAffected;
}

// ---------------------------------------------------------------- filters
export async function saveFilter(db, group, { keyword, matchMode, content, createdBy }) {
  await db.execute(
    `INSERT INTO group_filters (group_id, keyword, match_mode, content, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_id, keyword) DO UPDATE SET match_mode = excluded.match_mode, content = excluded.content, created_by = excluded.created_by`,
    [group.id, keyword, matchMode, JSON.stringify(content), createdBy ?? null, nowSec()],
  );
}
export const listFilters = (db, group) => db.all('SELECT keyword, match_mode, content FROM group_filters WHERE group_id = ? ORDER BY keyword', [group.id]);
export async function deleteFilter(db, group, keyword) {
  return (await db.execute('DELETE FROM group_filters WHERE group_id = ? AND keyword = ?', [group.id, keyword])).rowsAffected > 0;
}
export async function deleteAllFilters(db, group) {
  return (await db.execute('DELETE FROM group_filters WHERE group_id = ?', [group.id])).rowsAffected;
}

// ---------------------------------------------------------------- notes
export async function saveNote(db, group, { name, content, createdBy }) {
  const now = nowSec();
  await db.execute(
    `INSERT INTO group_notes (group_id, name, content, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_id, name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    [group.id, name, JSON.stringify(content), createdBy ?? null, now, now],
  );
}
export const getNote = (db, group, name) => db.first('SELECT name, content FROM group_notes WHERE group_id = ? AND name = ?', [group.id, name]);
export const listNotes = (db, group) => db.all('SELECT name FROM group_notes WHERE group_id = ? ORDER BY name', [group.id]);
export async function deleteNote(db, group, name) {
  return (await db.execute('DELETE FROM group_notes WHERE group_id = ? AND name = ?', [group.id, name])).rowsAffected > 0;
}
export async function deleteAllNotes(db, group) {
  return (await db.execute('DELETE FROM group_notes WHERE group_id = ?', [group.id])).rowsAffected;
}

// ---------------------------------------------------------------- blacklist
export async function addBlacklist(db, group, pattern, createdBy) {
  const res = await db.execute('INSERT OR IGNORE INTO group_blacklist (group_id, pattern, created_by, created_at) VALUES (?, ?, ?, ?)', [group.id, pattern, createdBy ?? null, nowSec()]);
  return res.rowsAffected > 0;
}
export async function removeBlacklist(db, group, pattern) {
  return (await db.execute('DELETE FROM group_blacklist WHERE group_id = ? AND pattern = ?', [group.id, pattern])).rowsAffected > 0;
}
export const listBlacklist = (db, group) => db.all('SELECT pattern FROM group_blacklist WHERE group_id = ? ORDER BY pattern', [group.id]);
export async function countBlacklist(db, group) {
  return Number(await db.value('SELECT COUNT(*) FROM group_blacklist WHERE group_id = ?', [group.id], 0));
}
export async function countFilters(db, group) {
  return Number(await db.value('SELECT COUNT(*) FROM group_filters WHERE group_id = ?', [group.id], 0));
}

// ---------------------------------------------------------------- greetings (welcome / goodbye)
export async function getGreeting(db, group, kind) {
  const row = await db.first('SELECT content FROM group_greetings WHERE group_id = ? AND kind = ?', [group.id, kind]);
  if (!row?.content) return null;
  try { return JSON.parse(row.content); } catch { return null; }
}
export async function saveGreeting(db, group, kind, content) {
  await db.execute(
    `INSERT INTO group_greetings (group_id, kind, content, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(group_id, kind) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    [group.id, kind, JSON.stringify(content), nowSec()],
  );
}
export async function deleteGreeting(db, group, kind) {
  return (await db.execute('DELETE FROM group_greetings WHERE group_id = ? AND kind = ?', [group.id, kind])).rowsAffected > 0;
}

// ---------------------------------------------------------------- scheduled deletes + housekeeping
export async function scheduleDelete(db, chatId, messageId, afterSec) {
  await db.execute('INSERT OR REPLACE INTO scheduled_deletes (chat_id, message_id, delete_at) VALUES (?, ?, ?)', [Number(chatId), Number(messageId), nowSec() + afterSec]);
}
export function dueDeletes(db, now = nowSec(), limit = 100) {
  return db.all('SELECT id, chat_id, message_id FROM scheduled_deletes WHERE delete_at <= ? ORDER BY delete_at LIMIT ?', [now, limit]);
}
export async function removeScheduledDeletes(db, ids) {
  for (const id of ids) await db.execute('DELETE FROM scheduled_deletes WHERE id = ?', [id]);
}

/** Old, finished rows only. Never touches active restrictions, open reports or live warnings. */
export async function purgeGroupHistory(db, now = nowSec()) {
  const out = {};
  out.warnings = (await db.execute('DELETE FROM group_warnings WHERE expires_at IS NOT NULL AND expires_at <= ?', [now])).rowsAffected;
  out.verifications = (await db.execute("DELETE FROM group_verifications WHERE status != 'pending' AND created_at < ?", [now - 86400])).rowsAffected;
  out.restrictions = (await db.execute("DELETE FROM group_restrictions WHERE status != 'active' AND created_at < ?", [now - 90 * 86400])).rowsAffected;
  out.reports = (await db.execute("DELETE FROM group_reports WHERE status != 'open' AND created_at < ?", [now - 90 * 86400])).rowsAffected;
  out.logs = (await db.execute('DELETE FROM group_moderation_logs WHERE created_at < ?', [now - 365 * 86400])).rowsAffected;
  return out;
}
