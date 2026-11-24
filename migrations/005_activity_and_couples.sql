-- Migration 005: activity_and_couples
-- Generated from src/database/schema.js by `npm run sql`. The bot applies this automatically on /setup.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_daily_counts (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id, day)
);

CREATE TABLE IF NOT EXISTS group_flood (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  window_end INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  muted_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_couples (
  chat_id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  pairs TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (5, 'activity_and_couples', CAST(strftime('%s','now') AS INTEGER));
