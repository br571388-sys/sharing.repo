// Idempotent migration runner and schema inspector. Never drops or rewrites existing data.

import { LATEST_SCHEMA_VERSION, MIGRATIONS, REQUIRED_COLUMNS, REQUIRED_TABLES, SCHEMA_MIGRATIONS_DDL, DEFAULT_BOT_SETTINGS } from './schema.js';
import { nowSec } from '../utils/helpers.js';

export async function currentVersion(db) {
  try {
    return Number(await db.value('SELECT COALESCE(MAX(version), 0) FROM schema_migrations', [], 0));
  } catch {
    return 0;
  }
}

/** Applies every pending migration. Safe to call on every /setup. Returns { applied, version }. */
export async function runMigrations(db) {
  await db.execute(SCHEMA_MIGRATIONS_DDL);
  const rows = await db.all('SELECT version FROM schema_migrations');
  const done = new Set(rows.map((r) => Number(r.version)));
  const applied = [];

  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    const statements = [
      ...m.statements.map((sql) => ({ sql, args: [] })),
      { sql: 'INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', args: [m.version, m.name, nowSec()] },
    ];
    await db.batch(statements);
    applied.push(m.version);
  }
  return { applied, version: await currentVersion(db) };
}

/** Reports missing tables / columns without changing anything. */
export async function inspectSchema(db) {
  const tableRows = await db.all("SELECT name FROM sqlite_master WHERE type = 'table'");
  const tables = new Set(tableRows.map((r) => r.name));
  const missingTables = REQUIRED_TABLES.filter((t) => !tables.has(t));
  const missingColumns = {};

  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    if (!tables.has(table)) continue;
    const info = await db.all(`SELECT name FROM pragma_table_info('${table}')`);
    const have = new Set(info.map((r) => r.name));
    const missing = cols.filter((c) => !have.has(c));
    if (missing.length) missingColumns[table] = missing;
  }

  const version = tables.has('schema_migrations') ? await currentVersion(db) : 0;
  return {
    version,
    latest: LATEST_SCHEMA_VERSION,
    missingTables,
    missingColumns,
    upToDate: version === LATEST_SCHEMA_VERSION && missingTables.length === 0 && Object.keys(missingColumns).length === 0,
  };
}

/** Inserts default bot settings that do not exist yet (never overwrites). Returns the keys created. */
export async function initDefaultSettings(db, config = {}) {
  const created = [];
  const defaults = { ...DEFAULT_BOT_SETTINGS };
  for (const [key, raw] of Object.entries(defaults)) {
    const value = typeof raw === 'function' ? raw() : raw;
    const res = await db.execute('INSERT OR IGNORE INTO bot_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)', [key, String(value), nowSec()]);
    if (res.rowsAffected > 0) created.push(key);
  }
  void config;
  return created;
}
