// Central configuration loader. Every setting comes from wrangler.toml [vars] or Cloudflare secrets (env).
// Nothing else in the project reads `env` for settings directly.

import { asBool, asInt, parseInterval } from '../utils/helpers.js';
import { configureUi } from '../ui/buttons.js';
import { isBotTokenFormat, isHttpUrl, isNumericId, isValidWebhookSecret } from '../utils/validation.js';

export const RESERVED_PATHS = ['/', '/setup', '/status', '/health', '/download'];
export const BOT_VERSION = '2.0.0';

const cache = new WeakMap();

const str = (v, fallback = '') => (v === undefined || v === null ? fallback : String(v).trim());

export function loadConfig(env = {}) {
  if (env && typeof env === 'object' && cache.has(env)) return cache.get(env);

  const backupRaw = str(env.BACKUP_INTERVAL, 'daily');
  const config = {
    botToken: str(env.BOT_TOKEN),
    ownerId: isNumericId(env.OWNER_ID) ? Number(String(env.OWNER_ID).trim()) : null,
    ownerIdRaw: str(env.OWNER_ID),
    webhookSecret: str(env.WEBHOOK_SECRET),
    setupSecret: str(env.SETUP_SECRET),
    botName: str(env.BOT_NAME, 'Bot'),
    botSlug: slugify(str(env.BOT_NAME, 'bot')),
    developerId: isNumericId(env.DEVELOPER_ID) ? Number(String(env.DEVELOPER_ID).trim()) : null,
    imageApiUrl: str(env.IMAGE_API_URL).replace(/\/+$/, ''), // optional: separate image.py service on Vercel (leaderboard, couple images)
    imageApiKey: str(env.IMAGE_API_KEY),
    cloneKey: str(env.CLONE_ENCRYPTION_KEY), // optional: needed only to create clone bots (32 random bytes, base64)
    developerIdRaw: str(env.DEVELOPER_ID),
    version: BOT_VERSION,

    turso: { url: str(env.TURSO_DATABASE_URL), token: str(env.TURSO_AUTH_TOKEN) },

    publicBaseUrl: str(env.PUBLIC_BASE_URL).replace(/\/+$/, ''),
    webhookPath: normalizePath(str(env.WEBHOOK_PATH, '/webhook')),

    links: {
      developer: str(env.DEVELOPER_URL),
      updates: str(env.UPDATES_CHANNEL_URL),
      addToGroup: str(env.ADD_TO_GROUP_URL),
    },
    welcomeImage: str(env.WELCOME_IMAGE),

    anime: {
      primary: str(env.ANIME_PRIMARY, 'taizen').toLowerCase() === 'anilist' ? 'anilist' : 'taizen',
      taizenUrl: str(env.ANIME_API, 'https://taizen.moe/api/graphql'),
      anilistUrl: str(env.ANILIST_API, 'https://graphql.anilist.co'),
    },
    translation: {
      provider: str(env.TRANSLATION_PROVIDER, 'mymemory').toLowerCase(),
      url: str(env.TRANSLATION_API, 'https://api.mymemory.translated.net/get'),
      email: str(env.MYMEMORY_EMAIL),
    },
    image: {
      provider: str(env.IMAGE_PROVIDER, 'pixabay').toLowerCase(),
      pixabayUrl: str(env.IMAGE_SEARCH_API, 'https://pixabay.com/api/'),
      pixabayKey: str(env.PIXABAY_API_KEY),
      wikimediaUrl: str(env.WIKIMEDIA_API, 'https://commons.wikimedia.org/w/api.php'),
    },

    backup: {
      enabled: asBool(env.BACKUP_ENABLED, true),
      intervalRaw: backupRaw,
      intervalMs: parseInterval(backupRaw),
      retention: asInt(env.BACKUP_RETENTION, 7, 1, 100),
      maxImportBytes: asInt(env.MAX_IMPORT_BYTES, 10 * 1024 * 1024, 1024, 20 * 1024 * 1024),
    },
    broadcast: {
      chunkSize: asInt(env.BROADCAST_CHUNK_SIZE, 25, 1, 200),
      concurrency: asInt(env.BROADCAST_CONCURRENCY, 10, 1, 25),
    },
    ttl: {
      anime: asInt(env.CACHE_TTL_ANIME, 3600, 30),
      schedule: asInt(env.CACHE_TTL_SCHEDULE, 1800, 30),
      translate: asInt(env.CACHE_TTL_TRANSLATE, 604800, 30),
      image: asInt(env.CACHE_TTL_IMAGE, 86400, 30),
    },
    buttonPopupAlert: asBool(env.BUTTON_POPUP_ALERT, true),
    reactions: asBool(env.REACTIONS, true),
    welcomeEffect: asBool(env.WELCOME_EFFECT, true),

    bindings: {
      queue: Boolean(env.BROADCAST_QUEUE && typeof env.BROADCAST_QUEUE.send === 'function'),
      r2: Boolean(env.BACKUPS && typeof env.BACKUPS.put === 'function'),
      kv: Boolean(env.CACHE && typeof env.CACHE.get === 'function'),
    },
  };

  configureUi({ styles: asBool(env.UI_BUTTON_STYLES, true), fancy: asBool(env.UI_FANCY_BUTTONS, true) });
  if (env && typeof env === 'object') cache.set(env, config);
  return config;
}

/** File-name / service-id friendly form of BOT_NAME. */
export function slugify(name) {
  return String(name || 'bot').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'bot';
}

/** The Developer button target: tg://user?id=<DEVELOPER_ID> (opens the profile pop-up), else DEVELOPER_URL. */
export function developerLink(config) {
  if (config.developerId && config.developerId > 0) return `tg://user?id=${config.developerId}`;
  return config.links.developer && isHttpUrl(config.links.developer) ? config.links.developer : '';
}

function normalizePath(p) {
  let path = p || '/webhook';
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path;
}

/** Returns { errors: string[], warnings: string[] } for anything that would stop the bot working. */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];

  if (!config.botToken) errors.push('BOT_TOKEN secret is not set.');
  else if (!isBotTokenFormat(config.botToken)) errors.push('BOT_TOKEN does not look like a Telegram bot token (expected 123456:ABC...).');

  if (!config.ownerIdRaw) errors.push('OWNER_ID is not set in wrangler.toml [vars].');
  else if (config.ownerId === null || config.ownerId <= 0) errors.push('OWNER_ID must be your numeric Telegram user id.');

  if (!config.webhookSecret) errors.push('WEBHOOK_SECRET secret is not set.');
  else if (!isValidWebhookSecret(config.webhookSecret)) errors.push('WEBHOOK_SECRET may only contain A-Z a-z 0-9 _ - (1-256 characters).');

  if (!config.setupSecret) errors.push('SETUP_SECRET secret is not set (it protects /setup and /status).');
  else if (config.setupSecret.length < 12) warnings.push('SETUP_SECRET is short; use at least 16 random characters.');

  if (!config.turso.url) errors.push('TURSO_DATABASE_URL secret is not set.');
  else if (!/^(libsql|https|http|wss|ws):\/\//i.test(config.turso.url)) errors.push('TURSO_DATABASE_URL must start with libsql:// or https://.');
  if (!config.turso.token) errors.push('TURSO_AUTH_TOKEN secret is not set.');

  if (RESERVED_PATHS.includes(config.webhookPath)) errors.push(`WEBHOOK_PATH cannot be "${config.webhookPath}" (reserved).`);
  if (config.publicBaseUrl) {
    if (!isHttpUrl(config.publicBaseUrl) || !config.publicBaseUrl.startsWith('https://')) errors.push('PUBLIC_BASE_URL must be an https:// URL (Telegram requires HTTPS).');
    else if (new URL(config.publicBaseUrl).pathname !== '/') errors.push('PUBLIC_BASE_URL must not contain a path.');
  }

  if (config.developerIdRaw && config.developerId === null) warnings.push('DEVELOPER_ID is not a numeric Telegram user id; the Developer button falls back to DEVELOPER_URL.');
  for (const [key, value] of [['DEVELOPER_URL', config.links.developer], ['UPDATES_CHANNEL_URL', config.links.updates], ['ADD_TO_GROUP_URL', config.links.addToGroup]]) {
    if (value && !isHttpUrl(value)) warnings.push(`${key} is not a valid http(s) URL; the matching button is hidden.`);
  }
  if (!config.backup.intervalMs) warnings.push(`BACKUP_INTERVAL "${config.backup.intervalRaw}" is invalid; automatic backups are disabled.`);
  if (config.image.provider === 'pixabay' && !config.image.pixabayKey) warnings.push('PIXABAY_API_KEY is not set; image search falls back to Wikimedia Commons.');

  return { errors, warnings };
}

/** Public URL the Worker is reachable at: configured PUBLIC_BASE_URL, else the origin of the current request. */
export function resolveBaseUrl(config, request) {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  if (request) return new URL(request.url).origin;
  return '';
}

export function webhookUrl(config, request) {
  const base = resolveBaseUrl(config, request);
  return base ? `${base}${config.webhookPath}` : '';
}
