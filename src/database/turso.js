// Turso (libSQL) client over the Hrana-over-HTTP pipeline API. Pure fetch(): works natively in Workers.
// https://docs.turso.tech/sdk/http/reference

import { DbError } from '../utils/errors.js';
import { fetchWithTimeout } from '../utils/helpers.js';

/** Query helpers shared by the real client and the in-memory test database. */
export class BaseDb {
  async execute() { throw new Error('not implemented'); }
  async batch() { throw new Error('not implemented'); }

  async first(sql, args = []) {
    const r = await this.execute(sql, args);
    return r.rows[0] ?? null;
  }

  async all(sql, args = []) {
    return (await this.execute(sql, args)).rows;
  }

  /** First column of the first row (or `fallback`). */
  async value(sql, args = [], fallback = null) {
    const row = await this.first(sql, args);
    if (!row) return fallback;
    const v = Object.values(row)[0];
    return v ?? fallback;
  }

  async ping() {
    const v = await this.value('SELECT 1 AS ok');
    return Number(v) === 1;
  }
}

export const st = (sql, ...args) => ({ sql, args });

export function toHttpUrl(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  u = u.replace(/^libsql:\/\//i, 'https://').replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
  return u;
}

function encodeValue(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { type: 'null' };
    return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  }
  if (v instanceof Uint8Array) return { type: 'blob', base64: btoa(String.fromCharCode(...v)) };
  return { type: 'text', value: String(v) };
}

function decodeValue(cell) {
  if (!cell || cell.type === 'null') return null;
  switch (cell.type) {
    case 'integer': {
      const n = Number(cell.value);
      return Number.isSafeInteger(n) ? n : cell.value;
    }
    case 'float': return Number(cell.value);
    case 'blob': return cell.base64;
    default: return cell.value;
  }
}

const encodeStmt = ({ sql, args = [] }) => ({ sql, args: args.map(encodeValue) });

function decodeResult(result) {
  const cols = (result.cols || []).map((c) => c.name);
  const rows = (result.rows || []).map((row) => {
    const obj = {};
    cols.forEach((name, i) => { obj[name] = decodeValue(row[i]); });
    return obj;
  });
  return {
    columns: cols,
    rows,
    rowsAffected: Number(result.affected_row_count || 0),
    lastInsertRowid: result.last_insert_rowid === undefined || result.last_insert_rowid === null ? null : Number(result.last_insert_rowid),
  };
}

const isReadOnly = (sql) => /^\s*(select|pragma|with)\b/i.test(sql) && !/\b(insert|update|delete)\b/i.test(sql);

export class TursoClient extends BaseDb {
  constructor({ url, authToken, timeoutMs = 15000 }) {
    super();
    if (!url) throw new DbError('TURSO_DATABASE_URL is not configured', { code: 'db_config' });
    if (!authToken) throw new DbError('TURSO_AUTH_TOKEN is not configured', { code: 'db_config' });
    this.baseUrl = toHttpUrl(url);
    this.authToken = authToken;
    this.timeoutMs = timeoutMs;
  }

  async pipeline(requests, { retry = false } = {}) {
    const body = JSON.stringify({ requests: [...requests, { type: 'close' }] });
    let lastError;
    for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
      try {
        const res = await fetchWithTimeout(`${this.baseUrl}/v2/pipeline`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.authToken}`, 'Content-Type': 'application/json' },
          body,
        }, this.timeoutMs);
        if (res.status === 401 || res.status === 403) {
          throw new DbError('Turso rejected the authentication token (HTTP ' + res.status + ')', { code: 'db_auth' });
        }
        if (res.status === 404) throw new DbError('Turso database not found (HTTP 404) — check TURSO_DATABASE_URL', { code: 'db_not_found' });
        if (!res.ok) {
          const text = (await res.text().catch(() => '')).slice(0, 300);
          const err = new DbError(`Turso HTTP ${res.status}: ${text}`, { code: 'db_http' });
          if (res.status >= 500 && attempt === 0 && retry) { lastError = err; continue; }
          throw err;
        }
        const json = await res.json();
        return json.results || [];
      } catch (e) {
        if (e instanceof DbError) throw e;
        lastError = new DbError(e?.name === 'AbortError' ? 'Turso request timed out' : `Turso network error: ${e?.message || e}`, { code: 'db_network', cause: e });
        if (!retry || attempt === 1) throw lastError;
      }
    }
    throw lastError;
  }

  async execute(sql, args = []) {
    const results = await this.pipeline([{ type: 'execute', stmt: encodeStmt({ sql, args }) }], { retry: isReadOnly(sql) });
    const r = results[0];
    if (!r) throw new DbError('Empty response from Turso');
    if (r.type === 'error') throw new DbError(r.error?.message || 'Turso query failed', { code: 'db_query' });
    return decodeResult(r.response.result);
  }

  /** Runs all statements in ONE transaction: either every statement applies or none does. */
  async batch(statements) {
    if (!statements.length) return [];
    const n = statements.length;
    const steps = [{ stmt: { sql: 'BEGIN' } }];
    statements.forEach((s, i) => steps.push({ stmt: encodeStmt(s), condition: { type: 'ok', step: i } }));
    steps.push({ stmt: { sql: 'COMMIT' }, condition: { type: 'ok', step: n } });
    steps.push({ stmt: { sql: 'ROLLBACK' }, condition: { type: 'not', cond: { type: 'ok', step: n + 1 } } });

    const results = await this.pipeline([{ type: 'batch', batch: { steps } }]);
    const r = results[0];
    if (!r) throw new DbError('Empty response from Turso');
    if (r.type === 'error') throw new DbError(r.error?.message || 'Turso batch failed', { code: 'db_query' });
    const { step_results: stepResults = [], step_errors: stepErrors = [] } = r.response.result;
    for (let i = 0; i <= n + 1; i++) {
      if (stepErrors[i]) throw new DbError(stepErrors[i].message || 'Turso batch step failed', { code: 'db_query' });
    }
    if (!stepResults[n + 1]) throw new DbError('Transaction was not committed', { code: 'db_query' });
    return stepResults.slice(1, n + 1).map((x) => decodeResult(x || {}));
  }
}

export function createDb(config) {
  return new TursoClient({ url: config.turso.url, authToken: config.turso.token });
}
