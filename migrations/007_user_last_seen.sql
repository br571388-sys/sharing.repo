-- Migration 007: user_last_seen
-- Generated from src/database/schema.js by `npm run sql`. The bot applies this automatically on /setup.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

ALTER TABLE users ADD COLUMN last_seen_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users (last_seen_at);

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (7, 'user_last_seen', CAST(strftime('%s','now') AS INTEGER));
