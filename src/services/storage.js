// Cloudflare R2 wrapper for backup files + signed, expiring download links.

import { hmacHex, nowSec, timingSafeEqual } from '../utils/helpers.js';

export class Storage {
  constructor(bucket = null) {
    this.bucket = bucket;
  }

  get configured() { return Boolean(this.bucket); }

  async put(key, body, { contentType = 'application/json', metadata = {} } = {}) {
    if (!this.bucket) throw new Error('R2 is not configured');
    return this.bucket.put(key, body, { httpMetadata: { contentType }, customMetadata: metadata });
  }

  async getText(key) {
    if (!this.bucket) return null;
    const obj = await this.bucket.get(key);
    return obj ? obj.text() : null;
  }

  async getObject(key) {
    return this.bucket ? this.bucket.get(key) : null;
  }

  async head(key) {
    return this.bucket ? this.bucket.head(key) : null;
  }

  async delete(keys) {
    if (!this.bucket) return;
    await this.bucket.delete(keys);
  }

  /** Lists all objects under a prefix (newest first by key because keys embed a sortable timestamp). */
  async list(prefix, limit = 1000) {
    if (!this.bucket) return [];
    const out = [];
    let cursor;
    do {
      const page = await this.bucket.list({ prefix, cursor, limit: Math.min(limit, 1000) });
      out.push(...page.objects);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor && out.length < limit);
    return out.sort((a, b) => (a.key < b.key ? 1 : -1));
  }

  /** Keeps the newest `keep` objects under prefix and deletes the rest. Returns deleted keys. */
  async prune(prefix, keep) {
    const objects = await this.list(prefix);
    const doomed = objects.slice(keep).map((o) => o.key);
    for (let i = 0; i < doomed.length; i += 100) await this.delete(doomed.slice(i, i + 100));
    return doomed;
  }
}

/** token = base64url(key).expiry.hmac — verified by the /download route. */
export async function signDownload(secret, key, ttlSec = 900) {
  const exp = nowSec() + ttlSec;
  const k = btoa(unescape(encodeURIComponent(key))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sig = await hmacHex(secret, `dl:${k}.${exp}`);
  return `${k}.${exp}.${sig}`;
}

export async function verifyDownload(secret, token) {
  const [k, exp, sig] = String(token || '').split('.');
  if (!k || !exp || !sig || Number(exp) < nowSec()) return null;
  const expected = await hmacHex(secret, `dl:${k}.${exp}`);
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const b64 = k.replace(/-/g, '+').replace(/_/g, '/');
    return decodeURIComponent(escape(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))));
  } catch {
    return null;
  }
}
