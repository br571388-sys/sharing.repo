// Sudo moderators, audit log, global bans (+ per-group results) and daily usage counters.
// Every statement is parameterised; user-supplied text only ever travels as a bound value.

import { nowSec } from '../utils/helpers.js';

// ------------------------------------------------------------------ sudo moderators

export async function isSudoUser(db, userId) {
  return Boolean(await db.first('SELECT 1 AS x FROM sudo_users WHERE user_id = ?', [Number(userId)]));
}

export async function addSudoUser(db, userId, addedBy) {
  const res = await db.execute('INSERT OR IGNORE INTO sudo_users (user_id, added_by, added_at) VALUES (?, ?, ?)', [Number(userId), Number(addedBy), nowSec()]);
  return res.rowsAffected > 0; // false = already present
}

export async function removeSudoUser(db, userId) {
  const res = await db.execute('DELETE FROM sudo_users WHERE user_id = ?', [Number(userId)]);
  return res.rowsAffected > 0;
}

export const listSudoUsers = (db) => db.all('SELECT user_id, added_by, added_at FROM sudo_users ORDER BY added_at');
export const countSudoUsers = async (db) => Number(await db.value('SELECT COUNT(*) FROM sudo_users'));

// ------------------------------------------------------------------ audit log

export async function logAudit(db, { actor, action, target = null, detail = null }) {
  await db.execute('INSERT INTO bot_audit_log (actor_id, action, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?)',
    [Number(actor), String(action).slice(0, 40), target === null ? null : Number(target), detail === null ? null : String(detail).slice(0, 500), nowSec()]);
}

export const recentAudit = (db, limit = 10, offset = 0) =>
  db.all('SELECT actor_id, action, target_id, detail, created_at FROM bot_audit_log ORDER BY id DESC LIMIT ? OFFSET ?', [limit, offset]);
export const countAudit = async (db) => Number(await db.value('SELECT COUNT(*) FROM bot_audit_log'));

// ------------------------------------------------------------------ global bans

export const getGlobalBan = (db, userId) => db.first('SELECT * FROM global_bans WHERE user_id = ?', [Number(userId)]);
export const isGloballyBanned = async (db, userId) => Boolean(await db.first("SELECT 1 AS x FROM global_bans WHERE user_id = ? AND status = 'active'", [Number(userId)]));

/** Creates (or re-activates) a global ban. Returns false when it was already active. */
export async function createGlobalBan(db, { userId, moderator, reason }) {
  const existing = await getGlobalBan(db, userId);
  if (existing?.status === 'active') return false;
  const now = nowSec();
  if (existing) {
    await db.execute("UPDATE global_bans SET status = 'active', moderator_id = ?, reason = ?, created_at = ?, lifted_by = NULL, lifted_at = NULL WHERE user_id = ?",
      [Number(moderator), reason ?? null, now, Number(userId)]);
  } else {
    await db.execute("INSERT INTO global_bans (user_id, moderator_id, reason, status, created_at) VALUES (?, ?, ?, 'active', ?)", [Number(userId), Number(moderator), reason ?? null, now]);
  }
  return true;
}

export async function liftGlobalBan(db, userId, liftedBy) {
  const res = await db.execute("UPDATE global_bans SET status = 'lifted', lifted_by = ?, lifted_at = ? WHERE user_id = ? AND status = 'active'", [Number(liftedBy), nowSec(), Number(userId)]);
  return res.rowsAffected > 0;
}

export const listGlobalBans = (db, limit = 8, offset = 0) =>
  db.all("SELECT * FROM global_bans WHERE status = 'active' ORDER BY created_at DESC, user_id LIMIT ? OFFSET ?", [limit, offset]);
export const countGlobalBans = async (db) => Number(await db.value("SELECT COUNT(*) FROM global_bans WHERE status = 'active'"));

// ------------------------------------------------------------------ per-group results

/** (Re)queues a ban for the given groups. Existing results are reset to pending so a re-ban is applied again. */
export async function queueBanResults(db, userId, chatIds) {
  const now = nowSec();
  for (const chatId of chatIds) {
    await db.execute(
      `INSERT INTO global_ban_results (user_id, chat_id, status, error, attempts, updated_at) VALUES (?, ?, 'pending', NULL, 0, ?)
       ON CONFLICT(user_id, chat_id) DO UPDATE SET status = 'pending', error = NULL, attempts = 0, updated_at = excluded.updated_at`,
      [Number(userId), Number(chatId), now],
    );
  }
}

/** Marks every group where the ban was applied (or is unknown) to be unbanned again. */
export async function queueUnbanResults(db, userId) {
  await db.execute("UPDATE global_ban_results SET status = 'unban_pending', error = NULL, attempts = 0, updated_at = ? WHERE user_id = ? AND status IN ('ok', 'failed', 'pending')", [nowSec(), Number(userId)]);
}

export const pendingResults = (db, limit = 30, userId = null) => userId === null
  ? db.all("SELECT user_id, chat_id, status, attempts FROM global_ban_results WHERE status IN ('pending', 'unban_pending') ORDER BY updated_at LIMIT ?", [limit])
  : db.all("SELECT user_id, chat_id, status, attempts FROM global_ban_results WHERE user_id = ? AND status IN ('pending', 'unban_pending') ORDER BY updated_at LIMIT ?", [Number(userId), limit]);

export async function setResult(db, userId, chatId, status, error = null) {
  await db.execute('UPDATE global_ban_results SET status = ?, error = ?, attempts = attempts + 1, updated_at = ? WHERE user_id = ? AND chat_id = ?',
    [status, error === null ? null : String(error).slice(0, 200), nowSec(), Number(userId), Number(chatId)]);
}

export async function resultSummary(db, userId) {
  const rows = await db.all('SELECT status, COUNT(*) AS n FROM global_ban_results WHERE user_id = ? GROUP BY status', [Number(userId)]);
  const out = { ok: 0, failed: 0, skipped: 0, pending: 0, lifted: 0 };
  for (const r of rows) {
    const k = r.status === 'unban_pending' ? 'pending' : r.status;
    out[k] = (out[k] || 0) + Number(r.n);
  }
  return out;
}

export const failedResults = (db, userId, limit = 5) =>
  db.all("SELECT chat_id, status, error FROM global_ban_results WHERE user_id = ? AND status IN ('failed', 'skipped') ORDER BY updated_at DESC LIMIT ?", [Number(userId), limit]);

export const activeGroupChatIds = async (db) =>
  (await db.all("SELECT telegram_chat_id FROM groups WHERE is_active = 1 AND group_type IN ('group', 'supergroup') ORDER BY id")).map((r) => Number(r.telegram_chat_id));

// ------------------------------------------------------------------ usage counters + dashboard statistics

export const dayKey = (sec = nowSec()) => new Date(sec * 1000).toISOString().slice(0, 10);

/** kind: 'cmd' (any command) — one atomic upsert per use. */
export async function bumpUsage(db, kind = 'cmd') {
  await db.execute('INSERT INTO usage_daily (day, kind, n) VALUES (?, ?, 1) ON CONFLICT(day, kind) DO UPDATE SET n = n + 1', [dayKey(), kind]);
}

export const usageForDay = async (db, day = dayKey(), kind = 'cmd') => Number((await db.value('SELECT n FROM usage_daily WHERE day = ? AND kind = ?', [day, kind])) || 0);
export const usageTotal = async (db, kind = 'cmd') => Number((await db.value('SELECT COALESCE(SUM(n), 0) FROM usage_daily WHERE kind = ?', [kind])) || 0);
export const usageLastDays = (db, days = 7, kind = 'cmd') =>
  db.all('SELECT day, n FROM usage_daily WHERE kind = ? ORDER BY day DESC LIMIT ?', [kind, days]);

export async function dashboardStats(db) {
  const since = nowSec() - 86400;
  const [users, groups, sudo, gbans, warns, modTotal, modToday, groupBans, newToday] = await Promise.all([
    db.first('SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN is_blocked = 0 THEN 1 ELSE 0 END), 0) AS active FROM users'),
    db.first('SELECT COUNT(*) AS total, COALESCE(SUM(is_active), 0) AS active FROM groups'),
    countSudoUsers(db),
    countGlobalBans(db),
    db.value("SELECT COUNT(*) FROM group_warnings WHERE expires_at IS NULL OR expires_at > ?", [nowSec()]),
    db.value('SELECT COUNT(*) FROM group_moderation_logs'),
    db.value('SELECT COUNT(*) FROM group_moderation_logs WHERE created_at >= ?', [since]),
    db.value("SELECT COUNT(*) FROM group_restrictions WHERE kind = 'ban' AND status = 'active'"),
    db.value('SELECT COUNT(*) FROM users WHERE created_at >= ?', [since]),
  ]);
  return {
    users: Number(users.total), activeUsers: Number(users.active), newUsersToday: Number(newToday),
    groups: Number(groups.total), activeGroups: Number(groups.active),
    sudo, globalBans: gbans, groupBans: Number(groupBans), warnings: Number(warns),
    modActions: Number(modTotal), modActionsToday: Number(modToday),
    commandsTotal: await usageTotal(db), commandsToday: await usageForDay(db),
    apiFailTotal: await usageTotal(db, 'api_fail'), apiFailToday: await usageForDay(db, dayKey(), 'api_fail'),
  };
}
