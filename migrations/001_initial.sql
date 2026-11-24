-- Migration 001: initial
-- Generated from src/database/schema.js by `npm run sql`. The bot applies this automatically on /setup.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language_code TEXT,
  is_blocked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_chat_id INTEGER NOT NULL UNIQUE,
  title TEXT,
  username TEXT,
  group_type TEXT NOT NULL DEFAULT 'group',
  owner_user_id INTEGER,
  owner_source TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  welcome_sent_at INTEGER,
  joined_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  setting_key TEXT NOT NULL,
  setting_value TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (group_id, setting_key)
);

CREATE TABLE IF NOT EXISTS group_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  data_type TEXT NOT NULL,
  data_key TEXT NOT NULL,
  data_value TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (group_id, data_type, data_key)
);

CREATE TABLE IF NOT EXISTS group_admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  telegram_user_id INTEGER NOT NULL,
  granted_by INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (group_id, telegram_user_id)
);

CREATE TABLE IF NOT EXISTS user_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  setting_key TEXT NOT NULL,
  setting_value TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, setting_key)
);

CREATE TABLE IF NOT EXISTS bot_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS broadcast_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_by INTEGER NOT NULL,
  target_type TEXT NOT NULL,
  message_payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'preparing',
  total_recipients INTEGER NOT NULL DEFAULT 0,
  successful_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  progress_chat_id INTEGER,
  progress_message_id INTEGER,
  progress_updated_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS broadcast_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES broadcast_jobs(id) ON DELETE CASCADE,
  chat_id INTEGER NOT NULL,
  chat_type TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (job_id, chat_id)
);

CREATE TABLE IF NOT EXISTS backup_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  backup_type TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  owner_id INTEGER,
  group_id INTEGER,
  backup_location TEXT,
  status TEXT NOT NULL DEFAULT 'success',
  size_bytes INTEGER,
  error_message TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS button_callbacks (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY,
  processed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cache_entries (
  cache_key TEXT PRIMARY KEY,
  cache_value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  rl_key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_blocked ON users (is_blocked);

CREATE INDEX IF NOT EXISTS idx_groups_active ON groups (is_active);

CREATE INDEX IF NOT EXISTS idx_groups_owner ON groups (owner_user_id);

CREATE INDEX IF NOT EXISTS idx_group_data_lookup ON group_data (group_id, data_type);

CREATE INDEX IF NOT EXISTS idx_group_admins_user ON group_admins (telegram_user_id);

CREATE INDEX IF NOT EXISTS idx_broadcast_jobs_status ON broadcast_jobs (status);

CREATE INDEX IF NOT EXISTS idx_broadcast_logs_job_status ON broadcast_logs (job_id, delivery_status);

CREATE INDEX IF NOT EXISTS idx_backup_logs_created ON backup_logs (created_at);

CREATE INDEX IF NOT EXISTS idx_pending_expires ON pending_actions (expires_at);

CREATE INDEX IF NOT EXISTS idx_processed_at ON processed_updates (processed_at);

CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries (expires_at);

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (1, 'initial', CAST(strftime('%s','now') AS INTEGER));
