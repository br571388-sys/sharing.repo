// Cache service: Cloudflare KV when the CACHE binding exists, otherwise the Turso cache_entries table.
// Cache problems never break a command: any failure just means "compute it again".

import { dbCacheGet, dbCacheSet } from '../database/state.js';
import { logger } from '../utils/logger.js';

export class Cache {
  constructor({ kv = null, getDb = null } = {}) {
    this.kv = kv;
    this.getDb = getDb;
  }

  get backend() { return this.kv ? 'kv' : 'database'; }

  async get(key) {
    try {
      const raw = this.kv ? await this.kv.get(key) : await dbCacheGet(this.getDb(), key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      logger.warn('cache get failed', { key, error: e?.message });
      return null;
    }
  }

  async set(key, value, ttlSec) {
    try {
      const raw = JSON.stringify(value);
      if (this.kv) await this.kv.put(key, raw, { expirationTtl: Math.max(60, ttlSec) });
      else await dbCacheSet(this.getDb(), key, raw, ttlSec);
    } catch (e) {
      logger.warn('cache set failed', { key, error: e?.message });
    }
  }

  /** Returns cached value or computes, stores and returns it. Only non-null results are cached. */
  async remember(key, ttlSec, compute) {
    const hit = await this.get(key);
    if (hit !== null) return { value: hit, cached: true };
    const value = await compute();
    if (value !== null && value !== undefined) await this.set(key, value, ttlSec);
    return { value, cached: false };
  }
}

/** Stable short cache key. */
export function cacheKey(...parts) {
  return parts.map((p) => String(p).toLowerCase().trim().replace(/\s+/g, ' ')).join('|').slice(0, 400);
}
