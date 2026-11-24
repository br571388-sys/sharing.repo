#!/usr/bin/env node
// Optional local helper. You do NOT need it to run the bot (the /setup page does the real work).
//
//   node scripts/setup.js gen       print fresh random WEBHOOK_SECRET and SETUP_SECRET values
//   node scripts/setup.js secrets   print the exact `wrangler secret put` commands
//   node scripts/setup.js check     check wrangler.toml for the values you still have to fill in
//   node scripts/setup.js sql       regenerate migrations/001_initial.sql from src/database/schema.js

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS, SCHEMA_MIGRATIONS_DDL } from '../src/database/schema.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const secret = (n = 24) => randomBytes(n).toString('base64url');

export function renderMigrationSql(migration) {
  const body = migration.statements.map((s) => `${s.trim()};`).join('\n\n');
  return `-- Migration ${String(migration.version).padStart(3, '0')}: ${migration.name}\n-- Generated from src/database/schema.js by \`npm run sql\`. The bot applies this automatically on /setup.\n\n${SCHEMA_MIGRATIONS_DDL};\n\n${body}\n\nINSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (${migration.version}, '${migration.name}', CAST(strftime('%s','now') AS INTEGER));\n`;
}

const commands = {
  gen() {
    console.log(`WEBHOOK_SECRET=${secret(24).replace(/[^A-Za-z0-9_-]/g, '')}`);
    console.log(`SETUP_SECRET=${secret(24)}`);
  },
  secrets() {
    console.log('Run each command and paste the value when asked:\n');
    for (const name of ['BOT_TOKEN', 'WEBHOOK_SECRET', 'SETUP_SECRET', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'PIXABAY_API_KEY (optional)']) {
      console.log(`  npx wrangler secret put ${name.split(' ')[0]}`);
    }
  },
  check() {
    const toml = readFileSync(join(root, 'wrangler.toml'), 'utf8');
    const get = (k) => (toml.match(new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, 'm')) || [])[1];
    const problems = [];
    if (!/^\d{5,}$/.test(get('OWNER_ID') || '')) problems.push('OWNER_ID is empty or not a number in wrangler.toml [vars].');
    if (!/^\/[A-Za-z0-9/_-]+$/.test(get('WEBHOOK_PATH') || '')) problems.push('WEBHOOK_PATH must start with "/".');
    if (/^\s*#\s*\[\[?queues/m.test(toml)) problems.push('Queue binding is commented out (broadcasts need it).');
    console.log(problems.length ? `Fix these:\n- ${problems.join('\n- ')}` : 'wrangler.toml looks good.');
    process.exitCode = problems.length ? 1 : 0;
  },
  sql() {
    for (const m of MIGRATIONS) {
      const file = join(root, 'migrations', `${String(m.version).padStart(3, '0')}_${m.name}.sql`);
      writeFileSync(file, renderMigrationSql(m));
      console.log(`wrote ${file}`);
    }
  },
};

const cmd = process.argv[2];
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!commands[cmd]) {
    console.log('Usage: node scripts/setup.js <gen|secrets|check|sql>');
    process.exit(1);
  }
  commands[cmd]();
}
