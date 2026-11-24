-- Migration 002: group_management
-- Generated from src/database/schema.js by `npm run sql`. The bot applies this automatically on /setup.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  match_mode TEXT NOT NULL DEFAULT 'word',
  content TEXT NOT NULL,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (group_id, keyword)
);

CREATE TABLE IF NOT EXISTS group_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (group_id, name)
);

CREATE TABLE IF NOT EXISTS group_blacklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (group_id, pattern)
);

CREATE TABLE IF NOT EXISTS group_greetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  content TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (group_id, kind)
);

CREATE TABLE IF NOT EXISTS group_warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  moderator_id INTEGER,
  reason TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS group_restrictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  moderator_id INTEGER,
  reason TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS group_moderation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  target_user_id INTEGER,
  moderator_id INTEGER,
  reason TEXT,
  related_message_id INTEGER,
  result TEXT NOT NULL DEFAULT 'success',
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  message_id INTEGER,
  answer TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_flood_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  rec_key TEXT NOT NULL DEFAULT '',
  hits INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (group_id, user_id, kind, rec_key)
);

CREATE TABLE IF NOT EXISTS group_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  reporter_id INTEGER NOT NULL,
  reported_user_id INTEGER,
  reported_message_id INTEGER NOT NULL,
  excerpt TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_by INTEGER,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS scheduled_deletes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  delete_at INTEGER NOT NULL,
  UNIQUE (chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_group_filters_group ON group_filters (group_id);

CREATE INDEX IF NOT EXISTS idx_group_notes_group ON group_notes (group_id);

CREATE INDEX IF NOT EXISTS idx_group_blacklist_group ON group_blacklist (group_id);

CREATE INDEX IF NOT EXISTS idx_group_warnings_user ON group_warnings (group_id, user_id);

CREATE INDEX IF NOT EXISTS idx_group_warnings_expiry ON group_warnings (expires_at);

CREATE INDEX IF NOT EXISTS idx_group_restrictions_user ON group_restrictions (group_id, user_id, status);

CREATE INDEX IF NOT EXISTS idx_group_restrictions_expiry ON group_restrictions (status, expires_at);

CREATE INDEX IF NOT EXISTS idx_group_modlog_group ON group_moderation_logs (group_id, created_at);

CREATE INDEX IF NOT EXISTS idx_group_modlog_target ON group_moderation_logs (group_id, target_user_id);

CREATE INDEX IF NOT EXISTS idx_group_verifications_expiry ON group_verifications (status, expires_at);

CREATE INDEX IF NOT EXISTS idx_group_flood_updated ON group_flood_records (updated_at);

CREATE INDEX IF NOT EXISTS idx_group_reports_group ON group_reports (group_id, status);

CREATE INDEX IF NOT EXISTS idx_scheduled_deletes_due ON scheduled_deletes (delete_at);

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (2, 'group_management', CAST(strftime('%s','now') AS INTEGER));
