-- Migration 006: clones
-- Generated from src/database/schema.js by `npm run sql`. The bot applies this automatically on /setup.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL,
  bot_id INTEGER NOT NULL UNIQUE,
  bot_username TEXT,
  bot_name TEXT NOT NULL,
  token_enc TEXT,
  db_url TEXT NOT NULL UNIQUE,
  db_token_enc TEXT,
  webhook_secret_enc TEXT,
  status TEXT NOT NULL,
  stopped_by TEXT NOT NULL DEFAULT 'none',
  maintenance INTEGER NOT NULL DEFAULT 0,
  broadcast_approved INTEGER NOT NULL DEFAULT 0,
  webhook_fail_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_active_at INTEGER,
  last_check_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  removed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_clones_owner ON clones (owner_user_id, status);

CREATE TABLE IF NOT EXISTS clone_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clone_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (6, 'clones', CAST(strftime('%s','now') AS INTEGER));
