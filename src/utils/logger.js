// Tiny structured logger that redacts secrets before anything is written.

const extraSecrets = new Set();

const PATTERNS = [
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, // Telegram bot tokens
  /(bot)\d{6,12}:[A-Za-z0-9_-]{30,}/gi, // tokens embedded in API URLs
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /([?&](?:key|token|secret|api_key|apikey)=)[^&\s"']+/gi,
];

/** Register exact secret values so they are scrubbed from every future log line. */
export function registerSecrets(values) {
  for (const v of values) if (typeof v === 'string' && v.length >= 6) extraSecrets.add(v);
}

export function redact(input) {
  let text = typeof input === 'string' ? input : safeStringify(input);
  for (const re of PATTERNS) text = text.replace(re, (m, p1) => (p1 ? `${p1}[REDACTED]` : '[REDACTED]'));
  for (const secret of extraSecrets) text = text.split(secret).join('[REDACTED]');
  return text;
}

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function emit(level, message, meta) {
  const line = redact(meta === undefined ? message : `${message} ${safeStringify(meta)}`);
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[${level}] ${line}`);
}

export const logger = {
  debug: (m, meta) => emit('debug', m, meta),
  info: (m, meta) => emit('info', m, meta),
  warn: (m, meta) => emit('warn', m, meta),
  error: (m, meta) => emit('error', m, meta),
};
