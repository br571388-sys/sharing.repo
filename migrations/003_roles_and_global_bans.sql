-- Migration 003: roles_and_global_bans
-- Generated from src/database/schema.js by `npm run sql`. The bot applies this automatically on /setup.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sudo_users (
  user_id INTEGER PRIMARY KEY,
  added_by INTEGER NOT NULL,
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_id INTEGER,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS global_bans (
  user_id INTEGER PRIMARY KEY,
  moderator_id INTEGER NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  lifted_by INTEGER,
  lifted_at INTEGER
);

CREATE TABLE IF NOT EXISTS global_ban_results (
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, chat_id)
);

CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON bot_audit_log (created_at);

CREATE INDEX IF NOT EXISTS idx_gban_results_status ON global_ban_results (status, updated_at);

CREATE INDEX IF NOT EXISTS idx_global_bans_status ON global_bans (status, created_at);

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (3, 'roles_and_global_bans', CAST(strftime('%s','now') AS INTEGER));
