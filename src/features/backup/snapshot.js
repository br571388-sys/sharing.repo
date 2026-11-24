// Creating and restoring backups. Format: JSON, documented in README ("Backup format").
//
//  global scope : full rows of every persistent table (internal ids preserved so references stay valid)
//  group scope  : ONLY that group's records, expressed with natural keys (telegram chat id), never internal ids
//
// Restores run inside a single database transaction and use bound parameters only: nothing in a backup file is
// ever executed as SQL or code.

import {
  BACKUP_FORMAT, BACKUP_VERSION, EPHEMERAL_SETTING_KEYS, GLOBAL_DELETE_ORDER, GLOBAL_TABLES, GROUP_TABLES, LATEST_SCHEMA_VERSION, V2_BACKUP_TABLES,
} from '../../database/schema.js';
import { sha256Hex, nowSec } from '../../utils/helpers.js';
import { currentVersion } from '../../database/migrations.js';

const cols = (spec) => Object.keys(spec);
const eph = () => EPHEMERAL_SETTING_KEYS.map(() => '?').join(',');

export async function checksumOf(tables) {
  return sha256Hex(JSON.stringify(tables));
}

async function envelope(db, scope, tables, extra = {}) {
  const now = nowSec();
  const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    schema_version: (await currentVersion(db)) || LATEST_SCHEMA_VERSION,
    scope,
    ...extra,
    created_at: new Date(now * 1000).toISOString(),
    created_at_unix: now,
    counts,
    tables,
    checksum: await checksumOf(tables),
  };
}

export async function exportGlobal(db) {
  const tables = {};
  for (const [table, spec] of Object.entries(GLOBAL_TABLES)) {
    const columns = cols(spec).join(', ');
    if (table === 'bot_settings') {
      tables[table] = await db.all(`SELECT ${columns} FROM bot_settings WHERE setting_key NOT IN (${eph()}) ORDER BY setting_key`, EPHEMERAL_SETTING_KEYS);
    } else if (table === 'broadcast_jobs') {
      // Only finished jobs: in-flight jobs cannot be resumed from a backup.
      tables[table] = await db.all(`SELECT ${columns} FROM broadcast_jobs WHERE status IN ('completed','cancelled','failed') ORDER BY id`);
    } else {
      const order = table === 'button_callbacks' ? 'id' : 'id';
      tables[table] = await db.all(`SELECT ${columns} FROM ${table} ORDER BY ${order}`);
    }
  }
  return envelope(db, 'global', tables);
}

/** Returns null when the group is not registered. */
export async function exportGroup(db, groupChatId) {
  const group = await db.first(`SELECT id, ${cols(GROUP_TABLES.groups).join(', ')} FROM groups WHERE telegram_chat_id = ?`, [Number(groupChatId)]);
  if (!group) return null;
  const { id, ...groupRow } = group;
  const tables = {
    groups: [groupRow],
    group_settings: await db.all(`SELECT ${cols(GROUP_TABLES.group_settings).join(', ')} FROM group_settings WHERE group_id = ? ORDER BY setting_key`, [id]),
    group_data: await db.all(`SELECT ${cols(GROUP_TABLES.group_data).join(', ')} FROM group_data WHERE group_id = ? ORDER BY data_type, data_key`, [id]),
    group_admins: await db.all(`SELECT ${cols(GROUP_TABLES.group_admins).join(', ')} FROM group_admins WHERE group_id = ? ORDER BY telegram_user_id`, [id]),
  };
  for (const table of V2_BACKUP_TABLES) {
    tables[table] = await db.all(`SELECT ${cols(GROUP_TABLES[table]).join(', ')} FROM ${table} WHERE group_id = ? ORDER BY id`, [id]);
  }
  return envelope(db, 'group', tables, { group_chat_id: Number(groupChatId) });
}

export const serialize = (backup) => JSON.stringify(backup, null, 2);

/** Multi-row INSERTs, chunked to stay far below SQLite's bound-parameter limit. */
function insertMany(table, columns, rows, { orIgnore = false } = {}) {
  const statements = [];
  const perRow = columns.length;
  const rowsPerStmt = Math.max(1, Math.floor(900 / perRow));
  for (let i = 0; i < rows.length; i += rowsPerStmt) {
    const slice = rows.slice(i, i + rowsPerStmt);
    const placeholders = slice.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
    statements.push({
      sql: `INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`,
      args: slice.flatMap((r) => columns.map((c) => r[c] ?? null)),
    });
  }
  return statements;
}

/** Builds the full replace transaction for a validated global backup. */
export function buildGlobalRestore(backup) {
  const statements = [];
  for (const table of GLOBAL_DELETE_ORDER) {
    if (table === 'bot_settings') statements.push({ sql: `DELETE FROM bot_settings WHERE setting_key NOT IN (${eph()})`, args: EPHEMERAL_SETTING_KEYS });
    else statements.push({ sql: `DELETE FROM ${table}`, args: [] });
  }
  for (const table of [...GLOBAL_DELETE_ORDER].reverse()) {
    const spec = GLOBAL_TABLES[table];
    if (!spec) continue;
    let rows = backup.tables[table] || [];
    if (table === 'bot_settings') rows = rows.filter((r) => !EPHEMERAL_SETTING_KEYS.includes(r.setting_key));
    statements.push(...insertMany(table, cols(spec), rows));
  }
  return statements;
}

/** Builds the transaction that replaces ONE group's settings/data (and admins when allowed). */
export function buildGroupRestore(backup, groupId, { restoreAdmins = false } = {}) {
  const statements = [
    { sql: 'DELETE FROM group_settings WHERE group_id = ?', args: [groupId] },
    { sql: 'DELETE FROM group_data WHERE group_id = ?', args: [groupId] },
  ];
  const withGroup = (rows) => rows.map((r) => ({ ...r, group_id: groupId }));
  statements.push(...insertMany('group_settings', ['group_id', ...cols(GROUP_TABLES.group_settings)], withGroup(backup.tables.group_settings)));
  statements.push(...insertMany('group_data', ['group_id', ...cols(GROUP_TABLES.group_data)], withGroup(backup.tables.group_data)));
  for (const table of V2_BACKUP_TABLES) {
    statements.push({ sql: `DELETE FROM ${table} WHERE group_id = ?`, args: [groupId] });
    statements.push(...insertMany(table, ['group_id', ...cols(GROUP_TABLES[table])], withGroup(backup.tables[table] || [])));
  }
  if (restoreAdmins) {
    statements.push({ sql: 'DELETE FROM group_admins WHERE group_id = ?', args: [groupId] });
    statements.push(...insertMany('group_admins', ['group_id', ...cols(GROUP_TABLES.group_admins)], withGroup(backup.tables.group_admins)));
  }
  // The groups row itself (ownership, title, active flag) is deliberately NOT restored: a backup file must never
  // be able to change who owns a group.
  return statements;
}

export async function restoreGlobal(db, backup) {
  await db.batch(buildGlobalRestore(backup));
}

export async function restoreGroup(db, backup, groupId, opts) {
  await db.batch(buildGroupRestore(backup, groupId, opts));
}

export function fileNameFor(backup, now = new Date(), slug = 'bot') {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  return backup.scope === 'group'
    ? `${slug}-group${String(backup.group_chat_id).replace('-', 'n')}-backup-${stamp}.json`
    : `${slug}-global-backup-${stamp}.json`;
}
