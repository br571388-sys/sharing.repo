// Backup validation (also used as the import "dry run"). Rejects anything unexpected before a single row is touched.

import { BACKUP_FORMAT, BACKUP_VERSION, GLOBAL_TABLES, GROUP_TABLES, LATEST_SCHEMA_VERSION, V2_BACKUP_TABLES } from '../../database/schema.js';
import { isPlainObject } from '../../utils/helpers.js';
import { checksumOf } from './snapshot.js';

const MAX_ROWS_PER_TABLE = 200000;
const MAX_STRING = 200000;

function checkValue(type, value) {
  const nullable = type.endsWith('?');
  const base = type.replace('?', '');
  if (value === null || value === undefined) return nullable;
  if (base === 'i') return Number.isSafeInteger(value);
  if (base === 's') return typeof value === 'string' && value.length <= MAX_STRING;
  return false;
}

function validateTable(name, spec, rows, errors) {
  if (!Array.isArray(rows)) { errors.push(`Table "${name}" must be a list of rows.`); return; }
  if (rows.length > MAX_ROWS_PER_TABLE) { errors.push(`Table "${name}" has too many rows.`); return; }
  const allowed = new Set(Object.keys(spec));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!isPlainObject(row)) { errors.push(`Table "${name}" row ${i + 1} is not an object.`); return; }
    for (const key of Object.keys(row)) {
      if (!allowed.has(key)) { errors.push(`Table "${name}" row ${i + 1} has an unexpected column "${String(key).slice(0, 40)}".`); return; }
    }
    for (const [col, type] of Object.entries(spec)) {
      if (!checkValue(type, row[col])) { errors.push(`Table "${name}" row ${i + 1}: invalid value for "${col}".`); return; }
    }
  }
}

function duplicates(rows, keyFn) {
  const seen = new Set();
  for (const r of rows) {
    const k = keyFn(r);
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

/**
 * Validates parsed-or-raw backup content.
 * Returns { ok, errors, backup, summary } — `backup` is only set when ok.
 */
export async function validateBackup(input) {
  const errors = [];
  let raw = input;
  if (typeof input === 'string') {
    try { raw = JSON.parse(input); } catch { return { ok: false, errors: ['The file is not valid JSON (it may be corrupted or not a backup made by this bot).'] }; }
  }
  if (!isPlainObject(raw)) return { ok: false, errors: ['The file does not contain a backup object.'] };
  if (raw.format !== BACKUP_FORMAT) return { ok: false, errors: ['This is not a backup file made by this bot (wrong format marker).'] };
  if (!Number.isInteger(raw.version) || raw.version < 1) return { ok: false, errors: ['The backup has no valid version.'] };
  if (raw.version > BACKUP_VERSION) return { ok: false, errors: [`Backup version ${raw.version} is newer than this bot supports (${BACKUP_VERSION}). Update the bot first.`] };
  if (!Number.isInteger(raw.schema_version) || raw.schema_version < 1 || raw.schema_version > LATEST_SCHEMA_VERSION) {
    return { ok: false, errors: [`Unsupported database schema version in backup (${String(raw.schema_version).slice(0, 10)}).`] };
  }
  if (raw.scope !== 'global' && raw.scope !== 'group') return { ok: false, errors: ['The backup scope must be "global" or "group".'] };
  if (!isPlainObject(raw.tables)) return { ok: false, errors: ['The backup has no tables.'] };
  if (typeof raw.checksum !== 'string') return { ok: false, errors: ['The backup has no checksum.'] };

  const specs = raw.scope === 'global' ? GLOBAL_TABLES : GROUP_TABLES;
  for (const name of Object.keys(raw.tables)) {
    if (!specs[name]) errors.push(`Unexpected table "${String(name).slice(0, 40)}" in a ${raw.scope} backup.`);
  }
  const legacy = raw.schema_version < 2; // pre-group-management backups do not have the v2 tables
  for (const name of Object.keys(specs)) {
    if (!(name in raw.tables) && !(legacy && V2_BACKUP_TABLES.includes(name))) errors.push(`Missing table "${name}".`);
  }
  if (errors.length) return { ok: false, errors };

  if (raw.scope === 'group') {
    if (!Number.isSafeInteger(raw.group_chat_id) || raw.group_chat_id >= 0) errors.push('The backup has no valid group id.');
  }
  for (const [name, spec] of Object.entries(specs)) {
    if (!(name in raw.tables)) continue;
    validateTable(name, spec, raw.tables[name], errors);
  }
  if (errors.length) return { ok: false, errors };

  if ((await checksumOf(raw.tables)) !== raw.checksum) {
    return { ok: false, errors: ['The checksum does not match: the file is corrupted or was modified.'] };
  }
  if (legacy) for (const name of V2_BACKUP_TABLES) raw.tables[name] ||= []; // checked above, after the checksum

  const t = raw.tables;
  if (raw.scope === 'global') {
    const userIds = new Set(t.users.map((r) => r.id));
    const groupIds = new Set(t.groups.map((r) => r.id));
    if (duplicates(t.users, (r) => r.id) || duplicates(t.users, (r) => r.telegram_user_id)) errors.push('Duplicate users in backup.');
    if (duplicates(t.groups, (r) => r.id) || duplicates(t.groups, (r) => r.telegram_chat_id)) errors.push('Duplicate groups in backup.');
    if (duplicates(t.group_settings, (r) => `${r.group_id}|${r.setting_key}`) || duplicates(t.group_settings, (r) => r.id)) errors.push('Duplicate group settings in backup.');
    if (duplicates(t.group_data, (r) => `${r.group_id}|${r.data_type}|${r.data_key}`) || duplicates(t.group_data, (r) => r.id)) errors.push('Duplicate group data in backup.');
    if (duplicates(t.group_admins, (r) => `${r.group_id}|${r.telegram_user_id}`) || duplicates(t.group_admins, (r) => r.id)) errors.push('Duplicate group admins in backup.');
    if (duplicates(t.user_settings, (r) => `${r.user_id}|${r.setting_key}`) || duplicates(t.user_settings, (r) => r.id)) errors.push('Duplicate user settings in backup.');
    if (duplicates(t.bot_settings, (r) => r.setting_key)) errors.push('Duplicate bot settings in backup.');
    if (duplicates(t.broadcast_jobs, (r) => r.id)) errors.push('Duplicate broadcast jobs in backup.');
    if (duplicates(t.button_callbacks, (r) => r.id)) errors.push('Duplicate button callbacks in backup.');
    if (t.group_settings.some((r) => !groupIds.has(r.group_id)) || t.group_data.some((r) => !groupIds.has(r.group_id)) || t.group_admins.some((r) => !groupIds.has(r.group_id))) {
      errors.push('Some records reference a group that is not in the backup.');
    }
    for (const [tbl, key] of [['group_filters', (r) => `${r.group_id}|${r.keyword}`], ['group_notes', (r) => `${r.group_id}|${r.name}`], ['group_blacklist', (r) => `${r.group_id}|${r.pattern}`], ['group_greetings', (r) => `${r.group_id}|${r.kind}`]]) {
      if (duplicates(t[tbl], key) || duplicates(t[tbl], (r) => r.id)) errors.push(`Duplicate rows in ${tbl}.`);
      if (t[tbl].some((r) => !groupIds.has(r.group_id))) errors.push(`Some ${tbl} records reference a group that is not in the backup.`);
    }
    if (t.user_settings.some((r) => !userIds.has(r.user_id))) errors.push('Some user settings reference a user that is not in the backup.');
  } else {
    if (t.groups.length !== 1) errors.push('A group backup must contain exactly one group.');
    else if (t.groups[0].telegram_chat_id !== raw.group_chat_id) errors.push('The group id inside the backup does not match its header.');
    if (duplicates(t.group_settings, (r) => r.setting_key)) errors.push('Duplicate group settings in backup.');
    if (duplicates(t.group_data, (r) => `${r.data_type}|${r.data_key}`)) errors.push('Duplicate group data in backup.');
    if (duplicates(t.group_admins, (r) => r.telegram_user_id)) errors.push('Duplicate group admins in backup.');
    if (duplicates(t.group_filters, (r) => r.keyword)) errors.push('Duplicate filters in backup.');
    if (duplicates(t.group_notes, (r) => r.name)) errors.push('Duplicate notes in backup.');
    if (duplicates(t.group_blacklist, (r) => r.pattern)) errors.push('Duplicate blacklist entries in backup.');
    if (duplicates(t.group_greetings, (r) => r.kind)) errors.push('Duplicate greetings in backup.');
  }
  if (errors.length) return { ok: false, errors };

  const counts = Object.fromEntries(Object.entries(raw.tables).map(([k, v]) => [k, v.length]));
  return {
    ok: true,
    errors: [],
    backup: raw,
    summary: {
      scope: raw.scope, version: raw.version, schemaVersion: raw.schema_version,
      createdAt: raw.created_at, createdAtUnix: raw.created_at_unix,
      groupChatId: raw.scope === 'group' ? raw.group_chat_id : null,
      groupTitle: raw.scope === 'group' ? raw.tables.groups[0].title : null,
      counts, checksum: raw.checksum,
    },
  };
}
