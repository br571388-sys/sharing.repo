// In-memory SQLite (node:sqlite) that implements the same interface as TursoClient, so the real SQL,
// migrations, backup/import and broadcast logic are tested against a real SQL engine.

import { DatabaseSync } from 'node:sqlite';
import { BaseDb } from '../../src/database/turso.js';
import { DbError } from '../../src/utils/errors.js';

const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

export class FakeDb extends BaseDb {
  constructor() {
    super();
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    this.fail = false; // flip to simulate an outage
    this.queries = 0;
  }

  run(sql, args = []) {
    const stmt = this.sqlite.prepare(sql);
    const params = args.map(norm);
    if (stmt.columns().length > 0) {
      const rows = stmt.all(...params).map((r) => ({ ...r }));
      return { columns: stmt.columns().map((c) => c.name), rows, rowsAffected: 0, lastInsertRowid: null };
    }
    const info = stmt.run(...params);
    return { columns: [], rows: [], rowsAffected: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
  }

  async execute(sql, args = []) {
    if (this.fail) throw new DbError('simulated outage', { code: 'db_network' });
    this.queries++;
    try {
      const r = this.run(sql, args);
      // RETURNING statements yield rows AND affect rows
      if (r.rows.length && /^\s*(update|insert|delete)/i.test(sql)) r.rowsAffected = r.rows.length;
      return r;
    } catch (e) {
      throw new DbError(e.message, { code: 'db_query', cause: e });
    }
  }

  async batch(statements) {
    if (this.fail) throw new DbError('simulated outage', { code: 'db_network' });
    this.sqlite.exec('BEGIN');
    try {
      const out = statements.map((s) => this.run(s.sql, s.args || []));
      this.sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      this.sqlite.exec('ROLLBACK');
      throw new DbError(e.message, { code: 'db_query', cause: e });
    }
  }
}

export async function makeDb({ migrate = true } = {}) {
  const db = new FakeDb();
  if (migrate) {
    const { runMigrations } = await import('../../src/database/migrations.js');
    await runMigrations(db);
  }
  return db;
}
