// Small dependency-free helpers (Web APIs only: works in Workers and Node 22).

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const nowSec = () => Math.floor(Date.now() / 1000);

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

export function asInt(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return clamp(n, min, max);
}

export function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export function truncate(str, max, ellipsis = '…') {
  const s = String(str ?? '');
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - ellipsis.length)).trimEnd() + ellipsis;
}

export function formatNumber(n) {
  return Number(n || 0).toLocaleString('en-US');
}

export function formatBytes(n) {
  const value = Number(n || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

export function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

const enc = new TextEncoder();

export function byteLength(str) {
  return enc.encode(String(str)).length;
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(String(text))));
}

export async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(String(data))));
}

/** Constant-time-ish string comparison (length is not secret here). */
export function timingSafeEqual(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

export function randomToken(bytes = 9) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** "hourly" | "daily" | "weekly" | "30m" | "6h" | "2d" -> milliseconds (0 when invalid). */
export function parseInterval(value) {
  const s = String(value ?? '').trim().toLowerCase();
  const named = { hourly: 3600e3, daily: 86400e3, weekly: 604800e3 };
  if (named[s]) return named[s];
  const m = s.match(/^(\d+)\s*(m|h|d)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
  return n > 0 ? n * unit : 0;
}

/** fetch() with a hard timeout. Uses the global fetch at call time so tests can stub it. */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Run async fn over items with limited concurrency, preserving order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function botIdFromToken(token) {
  const id = String(token || '').split(':')[0];
  return /^\d+$/.test(id) ? Number(id) : null;
}
