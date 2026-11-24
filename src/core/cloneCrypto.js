// Encryption for clone bot secrets (bot tokens, Turso tokens, webhook secrets). AES-256-GCM with a key from the
// CLONE_ENCRYPTION_KEY secret (32 random bytes, base64). Secrets are stored only as "iv.ciphertext" and never logged.

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function cloneKeyReady(keyB64) {
  try { return b64ToBytes(String(keyB64 || '').trim()).length === 32; } catch { return false; }
}

async function importKey(keyB64) {
  const raw = b64ToBytes(String(keyB64 || '').trim());
  if (raw.length !== 32) throw new Error('CLONE_ENCRYPTION_KEY must be 32 random bytes encoded as base64');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(keyB64, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(keyB64);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(String(plaintext))));
  return `${bytesToB64(iv)}.${bytesToB64(ct)}`;
}

export async function decryptSecret(keyB64, packed) {
  const [ivB64, ctB64] = String(packed || '').split('.');
  if (!ivB64 || !ctB64) throw new Error('malformed secret');
  const key = await importKey(keyB64);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(ivB64) }, key, b64ToBytes(ctB64));
  return dec.decode(pt);
}

/** A random webhook secret for Telegram (1–256 chars: A-Z a-z 0-9 _ -). */
export function newWebhookSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
