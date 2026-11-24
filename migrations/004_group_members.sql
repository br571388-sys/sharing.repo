-- Migration 004: group_members
-- Generated from src/database/schema.js by `npm run sql`. The bot applies this automatically on /setup.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  username TEXT,
  first_name TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  left_at INTEGER,
  PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_active ON group_members (chat_id, left_at);

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (4, 'group_members', CAST(strftime('%s','now') AS INTEGER));
