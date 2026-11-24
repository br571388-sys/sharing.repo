// Database schema, migration list and backup table specifications.
// migrations/001_initial.sql is generated from this file (`npm run sql`) and verified by tests.

export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial',
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language_code TEXT,
  is_blocked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`,
      `CREATE TABLE IF NOT EXISTS groups (
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
)`,
      `CREATE TABLE IF NOT EXISTS group_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  setting_key TEXT NOT NULL,
  setting_value TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (group_id, setting_key)
)`,
      `CREATE TABLE IF NOT EXISTS group_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  data_type TEXT NOT NULL,
  data_key TEXT NOT NULL,
  data_value TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (group_id, data_type, data_key)
)`,
      `CREATE TABLE IF NOT EXISTS group_admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  telegram_user_id INTEGER NOT NULL,
  granted_by INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (group_id, telegram_user_id)
)`,
      `CREATE TABLE IF NOT EXISTS user_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  setting_key TEXT NOT NULL,
  setting_value TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, setting_key)
)`,
      `CREATE TABLE IF NOT EXISTS bot_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT,
  updated_at INTEGER NOT NULL
)`,
      `CREATE TABLE IF NOT EXISTS broadcast_jobs (
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
)`,
      `CREATE TABLE IF NOT EXISTS broadcast_logs (
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
)`,
      `CREATE TABLE IF NOT EXISTS backup_logs (
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
)`,
      `CREATE TABLE IF NOT EXISTS button_callbacks (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`,
      `CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`,
      `CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY,
  processed_at INTEGER NOT NULL
)`,
      `CREATE TABLE IF NOT EXISTS cache_entries (
  cache_key TEXT PRIMARY KEY,
  cache_value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)`,
      `CREATE TABLE IF NOT EXISTS rate_limits (
  rl_key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
)`,
      'CREATE INDEX IF NOT EXISTS idx_users_blocked ON users (is_blocked)',
      'CREATE INDEX IF NOT EXISTS idx_groups_active ON groups (is_active)',
      'CREATE INDEX IF NOT EXISTS idx_groups_owner ON groups (owner_user_id)',
      'CREATE INDEX IF NOT EXISTS idx_group_data_lookup ON group_data (group_id, data_type)',
      'CREATE INDEX IF NOT EXISTS idx_group_admins_user ON group_admins (telegram_user_id)',
      'CREATE INDEX IF NOT EXISTS idx_broadcast_jobs_status ON broadcast_jobs (status)',
      'CREATE INDEX IF NOT EXISTS idx_broadcast_logs_job_status ON broadcast_logs (job_id, delivery_status)',
      'CREATE INDEX IF NOT EXISTS idx_backup_logs_created ON backup_logs (created_at)',
      'CREATE INDEX IF NOT EXISTS idx_pending_expires ON pending_actions (expires_at)',
      'CREATE INDEX IF NOT EXISTS idx_processed_at ON processed_updates (processed_at)',
      'CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache_entries (expires_at)',
    ],
  },
  {
    version: 2,
    name: 'group_management',
    statements: [
      `CREATE TABLE IF NOT EXISTS group_filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  match_mode TEXT NOT NULL DEFAULT 'word',
  content TEXT NOT NULL,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (group_id, keyword)
)`,
      `CREATE TABLE IF NOT EXISTS group_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (group_id, name)
)`,
      `CREATE TABLE IF NOT EXISTS group_blacklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (group_id, pattern)
)`,
      `CREATE TABLE IF NOT EXISTS group_greetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  content TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (group_id, kind)
)`,
      `CREATE TABLE IF NOT EXISTS group_warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  moderator_id INTEGER,
  reason TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
)`,
      `CREATE TABLE IF NOT EXISTS group_restrictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  moderator_id INTEGER,
  reason TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active'
)`,
      `CREATE TABLE IF NOT EXISTS group_moderation_logs (
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
)`,
      `CREATE TABLE IF NOT EXISTS group_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  message_id INTEGER,
  answer TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (group_id, user_id)
)`,
      `CREATE TABLE IF NOT EXISTS group_flood_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  rec_key TEXT NOT NULL DEFAULT '',
  hits INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (group_id, user_id, kind, rec_key)
)`,
      `CREATE TABLE IF NOT EXISTS group_reports (
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
)`,
      `CREATE TABLE IF NOT EXISTS scheduled_deletes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  delete_at INTEGER NOT NULL,
  UNIQUE (chat_id, message_id)
)`,
      'CREATE INDEX IF NOT EXISTS idx_group_filters_group ON group_filters (group_id)',
      'CREATE INDEX IF NOT EXISTS idx_group_notes_group ON group_notes (group_id)',
      'CREATE INDEX IF NOT EXISTS idx_group_blacklist_group ON group_blacklist (group_id)',
      'CREATE INDEX IF NOT EXISTS idx_group_warnings_user ON group_warnings (group_id, user_id)',
      'CREATE INDEX IF NOT EXISTS idx_group_warnings_expiry ON group_warnings (expires_at)',
      'CREATE INDEX IF NOT EXISTS idx_group_restrictions_user ON group_restrictions (group_id, user_id, status)',
      'CREATE INDEX IF NOT EXISTS idx_group_restrictions_expiry ON group_restrictions (status, expires_at)',
      'CREATE INDEX IF NOT EXISTS idx_group_modlog_group ON group_moderation_logs (group_id, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_group_modlog_target ON group_moderation_logs (group_id, target_user_id)',
      'CREATE INDEX IF NOT EXISTS idx_group_verifications_expiry ON group_verifications (status, expires_at)',
      'CREATE INDEX IF NOT EXISTS idx_group_flood_updated ON group_flood_records (updated_at)',
      'CREATE INDEX IF NOT EXISTS idx_group_reports_group ON group_reports (group_id, status)',
      'CREATE INDEX IF NOT EXISTS idx_scheduled_deletes_due ON scheduled_deletes (delete_at)',
    ],
  },
  {
    // Roles (sudo moderators), global bans with per-group results, owner/moderator audit log, daily usage counters.
    // Purely additive. These security records are intentionally NOT part of backups/imports.
    version: 3,
    name: 'roles_and_global_bans',
    statements: [
      `CREATE TABLE IF NOT EXISTS sudo_users (
  user_id INTEGER PRIMARY KEY,
  added_by INTEGER NOT NULL,
  added_at INTEGER NOT NULL
)`,
      `CREATE TABLE IF NOT EXISTS bot_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_id INTEGER,
  detail TEXT,
  created_at INTEGER NOT NULL
)`,
      `CREATE TABLE IF NOT EXISTS global_bans (
  user_id INTEGER PRIMARY KEY,
  moderator_id INTEGER NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  lifted_by INTEGER,
  lifted_at INTEGER
)`,
      `CREATE TABLE IF NOT EXISTS global_ban_results (
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, chat_id)
)`,
      `CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
)`,
      'CREATE INDEX IF NOT EXISTS idx_audit_created ON bot_audit_log (created_at)',
      'CREATE INDEX IF NOT EXISTS idx_gban_results_status ON global_ban_results (status, updated_at)',
      'CREATE INDEX IF NOT EXISTS idx_global_bans_status ON global_bans (status, created_at)',
    ],
  },
  {
    // Known group members (people the bot has seen speak or join in a group). Telegram cannot list all members,
    // so /all and /atag mention these. Operational data: not part of backups.
    version: 4,
    name: 'group_members',
    statements: [
      `CREATE TABLE IF NOT EXISTS group_members (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  username TEXT,
  first_name TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  left_at INTEGER,
  PRIMARY KEY (chat_id, user_id)
)`,
      'CREATE INDEX IF NOT EXISTS idx_group_members_active ON group_members (chat_id, left_at)',
    ],
  },
  {
    // Leaderboard and couples. Daily message counts are kept forever (history), so weekly / monthly boards and old results
    // stay available even after a member leaves. Flood state tracks the "5 messages in 2 seconds" rule.
    version: 5,
    name: 'activity_and_couples',
    statements: [
      `CREATE TABLE IF NOT EXISTS group_daily_counts (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id, day)
)`,
      `CREATE TABLE IF NOT EXISTS group_flood (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  window_end INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  muted_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
)`,
      `CREATE TABLE IF NOT EXISTS group_couples (
  chat_id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  pairs TEXT NOT NULL
)`,
    ],
  },
  {
    // Clone bots: one row per clone. Secrets are stored encrypted (see core/cloneCrypto.js); the clone's own data lives in
    // its own Turso database (db_url), never in this one. clone_notifications records owner DM delivery results.
    version: 6,
    name: 'clones',
    statements: [
      `CREATE TABLE IF NOT EXISTS clones (
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
)`,
      'CREATE INDEX IF NOT EXISTS idx_clones_owner ON clones (owner_user_id, status)',
      `CREATE TABLE IF NOT EXISTS clone_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clone_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
)`,
    ],
  },
  {
    version: 7,
    name: 'user_last_seen',
    statements: [
      'ALTER TABLE users ADD COLUMN last_seen_at INTEGER',
      'CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users (last_seen_at)',
    ],
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/** Every table the bot needs (schema_migrations is created by the migration runner). */
export const REQUIRED_TABLES = [
  'users', 'groups', 'group_settings', 'group_data', 'group_admins', 'user_settings', 'bot_settings',
  'broadcast_jobs', 'broadcast_logs', 'backup_logs', 'button_callbacks', 'pending_actions',
  'processed_updates', 'cache_entries', 'rate_limits', 'schema_migrations',
  'group_filters', 'group_notes', 'group_blacklist', 'group_greetings', 'group_warnings', 'group_restrictions',
  'group_moderation_logs', 'group_verifications', 'group_flood_records', 'group_reports', 'scheduled_deletes',
  'sudo_users', 'bot_audit_log', 'global_bans', 'global_ban_results', 'usage_daily',
];

export const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`;

/** Required columns per table (used by the setup verifier). */
export const REQUIRED_COLUMNS = {
  users: ['id', 'telegram_user_id', 'username', 'first_name', 'last_name', 'is_blocked', 'created_at', 'updated_at', 'last_seen_at'],
  groups: ['id', 'telegram_chat_id', 'title', 'username', 'group_type', 'owner_user_id', 'is_active', 'joined_at', 'updated_at'],
  group_settings: ['id', 'group_id', 'setting_key', 'setting_value', 'updated_at'],
  group_data: ['id', 'group_id', 'data_type', 'data_key', 'data_value', 'created_at', 'updated_at'],
  group_admins: ['id', 'group_id', 'telegram_user_id', 'granted_by', 'created_at'],
  user_settings: ['id', 'user_id', 'setting_key', 'setting_value', 'updated_at'],
  bot_settings: ['setting_key', 'setting_value', 'updated_at'],
  broadcast_jobs: ['id', 'created_by', 'target_type', 'message_payload', 'status', 'total_recipients', 'successful_count', 'failed_count', 'created_at', 'completed_at'],
  broadcast_logs: ['id', 'job_id', 'chat_id', 'delivery_status', 'error_message', 'created_at'],
  backup_logs: ['id', 'backup_type', 'owner_id', 'group_id', 'backup_location', 'created_at'],
};

/**
 * Backup table specs. `t` marks the column type used by the import validator:
 *   i = integer, s = text, n? = nullable (suffix ?).
 * Anything not listed here is rejected on import.
 */
export const BACKUP_VERSION = 1;
export const BACKUP_FORMAT = 'nobara-backup';

export const GLOBAL_TABLES = {
  users: { id: 'i', telegram_user_id: 'i', username: 's?', first_name: 's?', last_name: 's?', language_code: 's?', is_blocked: 'i', created_at: 'i', updated_at: 'i' },
  groups: { id: 'i', telegram_chat_id: 'i', title: 's?', username: 's?', group_type: 's', owner_user_id: 'i?', owner_source: 's?', is_active: 'i', welcome_sent_at: 'i?', joined_at: 'i', updated_at: 'i' },
  group_settings: { id: 'i', group_id: 'i', setting_key: 's', setting_value: 's?', updated_at: 'i' },
  group_data: { id: 'i', group_id: 'i', data_type: 's', data_key: 's', data_value: 's?', created_at: 'i', updated_at: 'i' },
  group_admins: { id: 'i', group_id: 'i', telegram_user_id: 'i', granted_by: 'i?', created_at: 'i' },
  user_settings: { id: 'i', user_id: 'i', setting_key: 's', setting_value: 's?', updated_at: 'i' },
  bot_settings: { setting_key: 's', setting_value: 's?', updated_at: 'i' },
  button_callbacks: { id: 's', text: 's', created_at: 'i' },
  group_filters: { id: 'i', group_id: 'i', keyword: 's', match_mode: 's', content: 's', created_by: 'i?', created_at: 'i' },
  group_notes: { id: 'i', group_id: 'i', name: 's', content: 's', created_by: 'i?', created_at: 'i', updated_at: 'i' },
  group_blacklist: { id: 'i', group_id: 'i', pattern: 's', created_by: 'i?', created_at: 'i' },
  group_greetings: { id: 'i', group_id: 'i', kind: 's', content: 's?', updated_at: 'i' },
  broadcast_jobs: {
    id: 'i', created_by: 'i', target_type: 's', message_payload: 's', status: 's', total_recipients: 'i', successful_count: 'i',
    failed_count: 'i', progress_chat_id: 'i?', progress_message_id: 'i?', progress_updated_at: 'i', last_error: 's?', created_at: 'i', updated_at: 'i', completed_at: 'i?',
  },
};

/**
 * Delete order for a global restore: children first. Insert order is the reverse (broadcast_logs are delivery logs
 * and are intentionally NOT part of backups; they are only deleted so no orphan rows remain).
 */
export const GLOBAL_DELETE_ORDER = [
  'broadcast_logs', 'broadcast_jobs', 'button_callbacks', 'group_filters', 'group_notes', 'group_blacklist', 'group_greetings', 'group_admins', 'group_data', 'group_settings',
  'user_settings', 'groups', 'users', 'bot_settings',
];

/** Group-scope tables use natural keys (no internal ids) so a backup is portable and isolated. */
export const GROUP_TABLES = {
  groups: { telegram_chat_id: 'i', title: 's?', username: 's?', group_type: 's', owner_user_id: 'i?', owner_source: 's?' },
  group_settings: { setting_key: 's', setting_value: 's?', updated_at: 'i' },
  group_data: { data_type: 's', data_key: 's', data_value: 's?', created_at: 'i', updated_at: 'i' },
  group_admins: { telegram_user_id: 'i', granted_by: 'i?', created_at: 'i' },
  group_filters: { keyword: 's', match_mode: 's', content: 's', created_by: 'i?', created_at: 'i' },
  group_notes: { name: 's', content: 's', created_by: 'i?', created_at: 'i', updated_at: 'i' },
  group_blacklist: { pattern: 's', created_by: 'i?', created_at: 'i' },
  group_greetings: { kind: 's', content: 's?', updated_at: 'i' },
};

/**
 * Tables introduced by schema v2. Backups made before v2 do not contain them; the validator treats them as empty.
 * Warnings, restrictions, moderation logs, reports, verifications and flood counters are operational/history data and
 * are intentionally NOT part of backups (see README).
 */
export const V2_BACKUP_TABLES = ['group_filters', 'group_notes', 'group_blacklist', 'group_greetings'];

/** bot_settings keys that describe runtime state, not configuration: never backed up or restored. */
export const EPHEMERAL_SETTING_KEYS = ['webhook_fingerprint', 'last_update_at', 'last_error', 'last_error_at', 'last_auto_backup_at', 'last_auto_backup_status', 'last_auto_backup_attempt_at', 'auto_backup_lock', 'bot_started_at', 'public_base_url', 'last_setup_at'];

export const DEFAULT_BOT_SETTINGS = {
  welcome_caption: '',
  welcome_image: '',
  bot_started_at: () => String(Math.floor(Date.now() / 1000)),
};
