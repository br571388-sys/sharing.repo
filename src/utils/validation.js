// Input validation helpers.

/** True only for absolute http(s) URLs with a hostname and sane length. */
export function isHttpUrl(value, maxLength = 2048) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return false;
  if (/\s/.test(value)) return false;
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.length > 0;
  } catch {
    return false;
  }
}

export function isHttpsUrl(value) {
  return isHttpUrl(value) && value.startsWith('https://');
}

export function isNumericId(value) {
  return /^-?\d{1,20}$/.test(String(value ?? '').trim());
}

/** Telegram secret_token rules: 1-256 chars, A-Z a-z 0-9 _ - */
export function isValidWebhookSecret(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

export function isBotTokenFormat(value) {
  return typeof value === 'string' && /^\d{5,15}:[A-Za-z0-9_-]{30,}$/.test(value);
}

/** Strip control characters (keeps \n and \t). */
export function cleanText(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/** Telegram deep-link / URL-safe check for a bot username (without @). */
export function isBotUsername(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value);
}
