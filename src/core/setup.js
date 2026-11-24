// /setup (one-click initialisation) and /status (diagnostics). Both are owner-protected by SETUP_SECRET.
//
// /setup validates and repairs everything it safely can and reports ONLY what it actually verified:
//   config -> Telegram token -> Turso + migrations -> Cloudflare bindings -> webhook (replace old one) -> APIs -> backups
// It is idempotent: running it again never duplicates data or replaces a webhook that is already correct.

import { ALLOWED_UPDATES } from './router.js';
import { RESERVED_PATHS, resolveBaseUrl, validateConfig } from './config.js';
import { createContext } from './bot.js';
import { menuCommands } from '../handlers/commands.js';
import { initDefaultSettings, inspectSchema, runMigrations } from '../database/migrations.js';
import { getBotSetting, setBotSetting } from '../database/settings.js';
import { hitRateLimit } from '../database/state.js';
import { LATEST_SCHEMA_VERSION } from '../database/schema.js';
import { broadcastTotals } from '../database/broadcasts.js';
import { lastBackup } from '../database/backups.js';
import { providers as animeProviders } from '../features/anime/provider.js';
import { providers as translationProviders } from '../features/translation/translate.js';
import { imageProviders } from '../features/imageSearch/imageSearch.js';
import { createValidatedBackup } from '../features/backup/manualBackup.js';
import { redact } from '../utils/logger.js';
import { errMsg, hmacHex, nowSec, sha256Hex, timingSafeEqual } from '../utils/helpers.js';
import { BOT_VERSION } from './config.js';

const COOKIE = 'nb_setup';
const SESSION_SEC = 1800;
const memoryLimiter = new Map();

export const htmlEsc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SECURITY_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

// ------------------------------------------------------------------ pages

const STYLE = `
:root{color-scheme:dark light}
body{margin:0;font:15px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#0f1115;color:#e6e8ee}
main{max-width:760px;margin:0 auto;padding:28px 18px 60px}
h1{font-size:18px;letter-spacing:.06em;margin:0 0 4px}
.sub{color:#8b93a7;margin:0 0 22px}
section{border:1px solid #232733;border-radius:12px;padding:14px 16px;margin:14px 0;background:#151821}
h2{font-size:13px;letter-spacing:.1em;margin:0 0 8px;color:#9fb4ff}
.row{display:flex;gap:10px;padding:3px 0;word-break:break-word}
.row b{font-weight:600}.row span.d{color:#8b93a7}
.banner{border-radius:12px;padding:16px;margin:18px 0;font-size:16px}
.good{background:#0f2a1c;border:1px solid #1f6b43}.bad{background:#2d1114;border:1px solid #8a2b33}.meh{background:#2a2410;border:1px solid #7a6620}
form{display:flex;flex-direction:column;gap:12px;max-width:380px}
input[type=password]{padding:10px 12px;border-radius:8px;border:1px solid #2c3142;background:#0f1115;color:inherit;font:inherit}
button{padding:10px 14px;border-radius:8px;border:0;background:#4f6df5;color:#fff;font:inherit;cursor:pointer}
code{background:#0f1115;padding:1px 6px;border-radius:5px}
@media (prefers-color-scheme:light){body{background:#f5f6fa;color:#1b1e27}section{background:#fff;border-color:#dfe2ec}.row span.d,.sub{color:#5b6378}h2{color:#3d55c9}input[type=password]{background:#fff;border-color:#c9cedd}code{background:#eef0f6}.good{background:#e6f6ec}.bad{background:#fdeaec}.meh{background:#fdf5dc}}
`;

const page = (title, body, status = 200, extraHeaders = {}) => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${htmlEsc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`,
  { status, headers: { ...SECURITY_HEADERS, ...extraHeaders } },
);

export function loginPage(next, { error = '', notConfigured = false, brand = 'BOT' } = {}) {
  const BRAND = htmlEsc(String(brand).toUpperCase());
  const body = notConfigured
    ? `<h1>${BRAND} — SETUP</h1><p class="sub">Setup is locked</p><div class="banner bad">🔒 <b>SETUP_SECRET is not configured.</b><br>Run <code>npx wrangler secret put SETUP_SECRET</code>, redeploy, and reload this page.</div>`
    : `<h1>${BRAND} — ACCESS DENIED</h1><p class="sub">This page is for the owner only. Enter your SETUP_SECRET to continue. Nothing is changed until you are unlocked.</p>${error ? `<div class="banner bad">🔒 ${htmlEsc(error)}</div>` : ''}
<form method="post" action="/setup"><input type="hidden" name="next" value="${htmlEsc(next)}"><input type="password" name="secret" placeholder="SETUP_SECRET" autocomplete="current-password" required autofocus><button type="submit">Unlock</button></form>`;
  return page(`${brand} — Access`, body, error || notConfigured ? 401 : 200);
}

// ------------------------------------------------------------------ authentication

async function sessionToken(secret, exp) {
  return `${exp}.${await hmacHex(secret, `session:${exp}`)}`;
}

async function validSession(secret, cookieValue) {
  const [exp, sig] = String(cookieValue || '').split('.');
  if (!exp || !sig || Number(exp) < nowSec()) return false;
  return timingSafeEqual(sig, await hmacHex(secret, `session:${exp}`));
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

/** Blocks repeated wrong-secret attempts (10 / 15 min per IP). Uses the database, with an in-memory fallback. */
async function tooManyFailures(ctx, request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = `setupfail:${(await sha256Hex(ip)).slice(0, 16)}`;
  try {
    const r = await hitRateLimit(ctx.db, key, 10, 900);
    return !r.allowed;
  } catch {
    const now = nowSec();
    const entry = memoryLimiter.get(key);
    if (!entry || entry.reset < now) { memoryLimiter.set(key, { n: 1, reset: now + 900 }); return false; }
    entry.n++;
    return entry.n > 10;
  }
}

/**
 * Returns { ok: true } or { ok: false, response }.
 * Accepts: valid session cookie, or `Authorization: Bearer <SETUP_SECRET>` / `X-Setup-Secret` (for curl).
 */
async function authenticate(request, ctx, next) {
  const secret = ctx.config.setupSecret;
  const brand = ctx.config.botName;
  if (!secret) return { ok: false, response: loginPage(next, { notConfigured: true, brand }) };

  if (await validSession(secret, readCookie(request, COOKIE))) return { ok: true };

  const header = request.headers.get('X-Setup-Secret') || (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (header) {
    if (timingSafeEqual(header, secret)) return { ok: true };
    if (await tooManyFailures(ctx, request)) return { ok: false, response: page('Too many attempts', '<div class="banner bad">⛔ Too many failed attempts. Try again in 15 minutes.</div>', 429) };
    return { ok: false, response: new Response('Unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } }) };
  }
  return { ok: false, response: loginPage(next, { brand }) };
}

// ------------------------------------------------------------------ report model

const ICON = { ok: '✅', warn: '⚠️', fail: '❌', skip: '➖', info: 'ℹ️' };

class Report {
  constructor() {
    this.sections = [];
    this.banner = '';
  }

  section(emoji, title, critical = false) {
    const s = { emoji, title, critical, items: [] };
    this.sections.push(s);
    return {
      add: (status, label, detail = '') => { s.items.push({ status, label, detail: redact(String(detail)) }); },
    };
  }

  get failures() {
    return this.sections.filter((s) => s.critical).flatMap((s) => s.items.filter((i) => i.status === 'fail').map((i) => ({ ...i, section: s.title })));
  }

  get ok() { return this.failures.length === 0; }
}

export function renderReport(report, { title, footer = '' }) {
  const sections = report.sections.map((s) => `<section><h2>${s.emoji} ${htmlEsc(s.title)}</h2>${s.items.map((i) => `<div class="row"><span>${ICON[i.status]}</span><div><b>${htmlEsc(i.label)}</b>${i.detail ? ` <span class="d">— ${htmlEsc(i.detail)}</span>` : ''}</div></div>`).join('')}</section>`).join('');
  return page(title, `<h1>${htmlEsc(title)}</h1><p class="sub">${htmlEsc(new Date().toISOString())}</p>${report.banner}${sections}${footer}`);
}

const safeUrl = (u) => {
  try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch { return '(invalid URL)'; }
};

const aliveText = (settled, name) => {
  if (settled.status === 'fulfilled') return ['ok', `${name}: Available`, settled.value || ''];
  // A rate limit means the service works but is busy right now (AniList allows ~90 requests per minute per IP).
  if (settled.reason?.code === 'rate_limited') return ['info', `${name}: Busy right now`, 'Rate limited by the provider. This is temporary; the bot retries and falls back automatically.'];
  return ['warn', `${name}: Unavailable`, errMsg(settled.reason).slice(0, 140)];
};

// ------------------------------------------------------------------ probes (shared by /setup and /status)

async function probeApis(ctx, section) {
  const [taizenP, anilistP] = animeProviders({ ...ctx.config, anime: { ...ctx.config.anime, primary: 'taizen' } });
  const probes = await Promise.allSettled([
    taizenP.search('one piece', 1).then((r) => (r.length ? `${r.length} result(s)` : 'reachable (no results)')),
    anilistP.search('one piece', 1).then((r) => (r.length ? `${r.length} result(s)` : 'reachable (no results)')),
    (translationProviders[ctx.config.translation.provider] || translationProviders.mymemory).translate(ctx.config, 'hello', 'en', 'es').then(() => 'test translation OK'),
    (async () => {
      const wanted = imageProviders[ctx.config.image.provider] || imageProviders.pixabay;
      const provider = wanted.available(ctx.config) ? wanted : imageProviders.wikimedia;
      const r = await provider.search(ctx.config, 'sunset');
      return `${provider.name}: ${r.length} result(s)`;
    })(),
  ]);
  section.add(...aliveText(probes[0], 'Anime API (Taizen)'));
  section.add(...aliveText(probes[1], 'Anime fallback (AniList)'));
  section.add(...aliveText(probes[2], 'Translation API'));
  const img = aliveText(probes[3], 'Image Search API');
  section.add(...img);
  if (ctx.config.image.provider === 'pixabay' && !ctx.config.image.pixabayKey) section.add('skip', 'Pixabay key', 'Not configured — Wikimedia Commons is used instead');
  if (probes[0].status === 'rejected' && probes[1].status === 'fulfilled') section.add('info', 'Anime provider', 'Taizen failed, so the bot will use AniList automatically');
}

async function probeBindings(ctx, section) {
  const { env, config } = ctx;
  section.add('ok', 'Worker', 'Running');
  const { errors, warnings } = validateConfig(config);
  section.add(errors.length ? 'fail' : 'ok', 'Environment Configuration', errors.length ? `${errors.length} problem(s) — see Configuration above` : (warnings.length ? `Valid (${warnings.length} warning(s))` : 'Valid'));

  if (config.bindings.kv) {
    try { await env.CACHE.get('__ping'); section.add('ok', 'KV Binding (CACHE)', 'Connected'); } catch (e) { section.add('warn', 'KV Binding (CACHE)', `Bound but not usable: ${errMsg(e)}`); }
  } else section.add('skip', 'KV Binding (CACHE)', 'Not configured — the database is used as cache');

  if (config.bindings.r2) {
    try { await env.BACKUPS.list({ limit: 1 }); section.add('ok', 'R2 Binding (BACKUPS)', 'Connected'); } catch (e) { section.add('warn', 'R2 Binding (BACKUPS)', `Bound but not usable: ${errMsg(e)}`); }
  } else section.add('skip', 'R2 Binding (BACKUPS)', 'Not configured — backups are delivered through Telegram');

  section.add(config.bindings.queue ? 'ok' : 'warn', 'Queue Binding (BROADCAST_QUEUE)', config.bindings.queue ? 'Bound (producer)' : 'Not configured — broadcasts are disabled until the queue is created');
}

// ------------------------------------------------------------------ /setup

export async function runSetup(ctx, request) {
  const { config } = ctx;
  const report = new Report();
  const tg = ctx.tg;

  // 1. configuration
  const cfg = report.section('⚙️', 'CONFIGURATION', true);
  const { errors, warnings } = validateConfig(config);
  if (!errors.length) cfg.add('ok', 'Configuration', 'All required settings are present and well-formed');
  errors.forEach((e) => cfg.add('fail', 'Missing / invalid', e));
  warnings.forEach((w) => cfg.add('warn', 'Warning', w));

  // 2. telegram
  const tgs = report.section('🤖', 'TELEGRAM BOT', true);
  let bot = null;
  if (!config.botToken) tgs.add('fail', 'Bot Token', 'BOT_TOKEN is not set');
  else {
    try {
      bot = await tg.getMe();
      tgs.add('ok', 'Bot Token', 'Valid');
      tgs.add('ok', 'Bot Connection', 'Connected');
      tgs.add('ok', 'Bot Username', `@${bot.username}`);
      if (!bot.can_join_groups) tgs.add('warn', 'Groups', 'This bot cannot join groups — enable it in @BotFather (Bot Settings → Allow Groups)');
    } catch (e) {
      tgs.add('fail', 'Bot Token', `Telegram rejected the token: ${errMsg(e)}`);
    }
  }

  // 3. database
  const dbs = report.section('🗄', 'DATABASE STATUS', true);
  let dbReady = false;
  let alreadyConfigured = false;
  if (!config.turso.url || !config.turso.token) {
    dbs.add('fail', 'Turso Connection', 'TURSO_DATABASE_URL / TURSO_AUTH_TOKEN are not set');
  } else {
    try {
      await ctx.db.ping();
      dbs.add('ok', 'Turso Connection', 'Connected');
      dbs.add('ok', 'Database Authentication', 'Successful');
      const before = await inspectSchema(ctx.db).catch(() => null);
      alreadyConfigured = Boolean(before && before.version > 0 && (await getBotSetting(ctx.db, 'webhook_fingerprint', null).catch(() => null)));
      const mig = await runMigrations(ctx.db);
      dbs.add('ok', 'Migrations', mig.applied.length ? `Applied version(s): ${mig.applied.join(', ')}` : 'Nothing to apply (already up to date)');
      const after = await inspectSchema(ctx.db);
      dbs.add(after.missingTables.length ? 'fail' : 'ok', 'Required Tables', after.missingTables.length ? `Missing: ${after.missingTables.join(', ')}` : 'Verified');
      const cols = Object.entries(after.missingColumns);
      dbs.add(cols.length ? 'fail' : 'ok', 'Required Columns', cols.length ? cols.map(([t, c]) => `${t}: ${c.join(', ')}`).join('; ') : 'Verified');
      dbs.add(after.version === LATEST_SCHEMA_VERSION ? 'ok' : 'fail', 'Database Schema', after.version === LATEST_SCHEMA_VERSION ? `Up to date (v${after.version})` : `At v${after.version}, expected v${LATEST_SCHEMA_VERSION}`);
      const created = await initDefaultSettings(ctx.db, config);
      dbs.add('ok', 'Default Settings', created.length ? `Created: ${created.join(', ')}` : 'Already initialised');
      dbReady = after.upToDate;
    } catch (e) {
      dbs.add('fail', 'Turso Connection', errMsg(e));
    }
  }

  // 4. cloudflare
  await probeBindings(ctx, report.section('☁️', 'CLOUDFLARE STATUS'));

  // 5. webhook
  const wh = report.section('🔗', 'WEBHOOK STATUS', true);
  if (!bot) wh.add('skip', 'Webhook', 'Skipped: the Telegram bot token is not valid yet');
  else await setupWebhook(ctx, request, wh, dbReady);

  // 6. APIs
  await probeApis(ctx, report.section('🌐', 'API SERVICES'));

  // 7. backup system
  const bk = report.section('💾', 'BACKUP SYSTEM');
  bk.add(config.bindings.r2 ? 'ok' : 'skip', 'Backup Storage', config.bindings.r2 ? 'R2 bucket connected' : 'Not configured — backups are delivered through Telegram');
  if (!config.backup.enabled) bk.add('skip', 'Automatic Backup', 'Disabled (BACKUP_ENABLED=false)');
  else if (!config.backup.intervalMs) bk.add('fail', 'Automatic Backup', `BACKUP_INTERVAL "${config.backup.intervalRaw}" is invalid`);
  else bk.add('ok', 'Automatic Backup', `Enabled — every ${config.backup.intervalRaw}, keeping ${config.backup.retention}. Needs the Cron Trigger from wrangler.toml (cannot be verified from inside the Worker).`);
  if (dbReady) {
    try {
      const made = await createValidatedBackup(ctx, 'global');
      bk.add('ok', 'Database Schema Backup', `Verified (test export validated, ${made.bytes.length} bytes, not stored)`);
    } catch (e) { bk.add('fail', 'Database Schema Backup', errMsg(e)); }
  } else bk.add('skip', 'Database Schema Backup', 'Skipped: database not ready');

  // final banner
  if (report.ok) {
    report.banner = `<div class="banner good">🎉 <b>SETUP COMPLETED</b><br>🤖 Your bot is ready!${bot ? `<br>Bot: <b>@${htmlEsc(bot.username)}</b>` : ''}<br>Open Telegram and send <code>/start</code>.</div>`;
    if (alreadyConfigured) report.banner = `<div class="banner meh">✅ <b>Bot Already Configured</b><br>🔄 System verification finished — nothing was damaged or duplicated.</div>${report.banner}`;
  } else {
    const first = report.failures[0];
    report.banner = `<div class="banner bad">❌ <b>Setup Failed</b><br>Reason: ${htmlEsc(first.label)} — ${htmlEsc(first.detail)}<br><small>${report.failures.length} critical problem(s). Steps marked ✅ succeeded; steps marked ❌ need fixing, then reload this page.</small></div>`;
  }

  if (report.ok && dbReady) {
    await setBotSetting(ctx.db, 'last_setup_at', nowSec()).catch(() => {});
    if (config.ownerId) {
      await tg.sendMessage(config.ownerId, `✅ <b>Setup completed</b>\n\nBot: @${bot.username}\nSystem verification passed. Send /help to see what I can do.`).catch(() => {});
    }
  }
  return report;
}

async function setupWebhook(ctx, request, wh, dbReady) {
  const { config, tg } = ctx;
  const base = resolveBaseUrl(config, request);
  const expected = `${base}${config.webhookPath}`;

  if (!base.startsWith('https://')) { wh.add('fail', 'Worker URL', `"${safeUrl(base)}" is not HTTPS. Telegram requires HTTPS — open /setup through your deployed https:// URL (not wrangler dev), or set PUBLIC_BASE_URL.`); return; }
  if (RESERVED_PATHS.includes(config.webhookPath)) { wh.add('fail', 'Webhook Path', `${config.webhookPath} is reserved`); return; }
  wh.add('ok', 'Webhook URL', `${safeUrl(expected)} (auto-detected${config.publicBaseUrl ? ' from PUBLIC_BASE_URL' : ' from this request'})`);

  try {
    const info = await tg.getWebhookInfo();
    const current = info.url || '';
    const fingerprint = await sha256Hex(`${expected}|${config.webhookSecret}|${ALLOWED_UPDATES.join(',')}`);
    const stored = dbReady ? await getBotSetting(ctx.db, 'webhook_fingerprint', null).catch(() => null) : null;

    let action;
    if (!current) { action = 'set'; wh.add('info', 'Current Webhook', 'None configured'); }
    else if (current !== expected) {
      action = 'replace';
      wh.add('warn', 'Previous Webhook', `Different URL detected: ${safeUrl(current)}`);
      if (config.ownerId) await tg.sendMessage(config.ownerId, `🔄 <b>Webhook change</b>\n\nThe previous webhook (${htmlEsc(safeUrl(current))}) will be replaced by this Worker.`).catch(() => {});
      wh.add('info', 'Replacing Previous Webhook', 'Calling setWebhook directly (no deleteWebhook, pending updates are kept)');
    } else if (stored === fingerprint) { action = 'keep'; wh.add('ok', 'Existing Webhook', 'Already correct — not replaced'); }
    else { action = 'reapply'; wh.add('info', 'Existing Webhook', 'URL is correct; re-applying once to confirm the secret token and allowed updates'); }

    if (action !== 'keep') {
      await tg.setWebhook({ url: expected, secret_token: config.webhookSecret, allowed_updates: ALLOWED_UPDATES, max_connections: 40 });
    }

    const after = await tg.getWebhookInfo();
    if (after.url === expected) {
      wh.add('ok', action === 'replace' ? 'New Webhook' : 'Webhook', 'Active — Telegram reports the expected URL');
      wh.add('ok', 'Webhook Secret', action === 'keep' ? 'Configured (applied during an earlier setup)' : 'Configured — sent to Telegram with setWebhook');
      if (dbReady) {
        await setBotSetting(ctx.db, 'webhook_fingerprint', fingerprint);
        await setBotSetting(ctx.db, 'public_base_url', base);
      }
    } else wh.add('fail', 'Webhook', `Telegram still reports ${after.url ? safeUrl(after.url) : 'no webhook'} after setWebhook`);

    wh.add('info', 'Pending Updates', String(after.pending_update_count ?? 0));
    if (after.last_error_message) wh.add('warn', 'Telegram Last Error', `${after.last_error_message}${after.last_error_date ? ` (${new Date(after.last_error_date * 1000).toISOString()})` : ''}`);
  } catch (e) {
    wh.add('fail', 'Webhook', `Telegram rejected the webhook configuration: ${errMsg(e)}`);
    return;
  }

  // command menus (best effort)
  try {
    await tg.setMyCommands(menuCommands('default'));
    await tg.setMyCommands(menuCommands('groups'), { type: 'all_group_chats' });
    await tg.setMyCommands(menuCommands('admins'), { type: 'all_chat_administrators' });
    if (config.ownerId) await tg.setMyCommands(menuCommands('owner'), { type: 'chat', chat_id: config.ownerId });
    wh.add('ok', 'Command Menus', 'Updated for users, group admins and the owner');
  } catch (e) {
    wh.add('warn', 'Command Menus', `Could not update: ${errMsg(e)}`);
  }
}

// ------------------------------------------------------------------ /status

export async function runStatus(ctx, request) {
  const { config } = ctx;
  const report = new Report();

  const bot = report.section('🤖', 'TELEGRAM BOT');
  try {
    const me = await ctx.tg.getMe();
    bot.add('ok', 'Bot Connection', 'Connected');
    bot.add('ok', 'Bot Identity', `@${me.username} (id ${me.id})`);
    const info = await ctx.tg.getWebhookInfo();
    const expected = `${resolveBaseUrl(config, request)}${config.webhookPath}`;
    const wh = report.section('🔗', 'WEBHOOK');
    wh.add(info.url === expected ? 'ok' : 'warn', 'Webhook URL', info.url ? (info.url === expected ? 'Matches this Worker' : `Points elsewhere: ${safeUrl(info.url)} — run /setup`) : 'Not set — run /setup');
    wh.add('info', 'Pending Updates', String(info.pending_update_count ?? 0));
    if (info.last_error_message) wh.add('warn', 'Telegram Last Error', info.last_error_message);
  } catch (e) {
    bot.add('fail', 'Bot Connection', errMsg(e));
  }

  const db = report.section('🗄', 'DATABASE');
  try {
    const t = Date.now();
    await ctx.db.ping();
    db.add('ok', 'Connection', `Connected (${Date.now() - t} ms)`);
    const schema = await inspectSchema(ctx.db);
    db.add(schema.upToDate ? 'ok' : 'warn', 'Schema Version', `v${schema.version} of v${schema.latest}${schema.upToDate ? '' : ' — run /setup'}`);
    const lastUpdate = await getBotSetting(ctx.db, 'last_update_at', null);
    db.add(lastUpdate ? 'ok' : 'info', 'Last Successful Update', lastUpdate ? new Date(Number(lastUpdate) * 1000).toISOString() : 'none yet');
    const lastError = await getBotSetting(ctx.db, 'last_error', null);
    db.add(lastError ? 'warn' : 'ok', 'Last Error', lastError ? `${lastError} (${new Date(Number(await getBotSetting(ctx.db, 'last_error_at', 0)) * 1000).toISOString()})` : 'none recorded');

    const q = report.section('📬', 'QUEUE');
    const totals = await broadcastTotals(ctx.db);
    q.add(config.bindings.queue ? 'ok' : 'warn', 'Queue Binding', config.bindings.queue ? 'Bound' : 'Not configured');
    q.add('info', 'Broadcast Jobs', `${totals.jobs} total, ${totals.active} active`);

    const bk = report.section('💾', 'BACKUPS');
    const last = await lastBackup(ctx.db);
    const auto = await getBotSetting(ctx.db, 'last_auto_backup_at', null);
    bk.add(config.bindings.r2 ? 'ok' : 'skip', 'Storage', config.bindings.r2 ? 'R2 connected' : 'Not configured (Telegram delivery)');
    bk.add(auto ? 'ok' : 'info', 'Last Automatic Backup', auto ? `${new Date(Number(auto) * 1000).toISOString()} — ${await getBotSetting(ctx.db, 'last_auto_backup_status', '')}` : 'none yet');
    if (last) bk.add(last.status === 'success' ? 'ok' : 'warn', 'Last Backup (any)', `${last.backup_type}/${last.scope} — ${last.status}`);
  } catch (e) {
    db.add('fail', 'Connection', errMsg(e));
  }

  await probeApis(ctx, report.section('🌐', 'API SERVICES'));
  report.banner = `<div class="banner ${report.sections.some((s) => s.items.some((i) => i.status === 'fail')) ? 'bad' : 'good'}">📊 <b>System status</b> — v${htmlEsc(BOT_VERSION)}</div>`;
  await probeApis(ctx, report.section('🌐', 'API SERVICES'));
  return report;
}

// ------------------------------------------------------------------ route handler

/** Handles /setup and /status. */
export async function handleAdminRoute(request, env, executionCtx, overrides = {}) {
  const url = new URL(request.url);
  const path = url.pathname;
  const next = path === '/status' ? '/status' : '/setup';
  const ctx = createContext(env, executionCtx, overrides);

  if (request.method === 'POST' && path === '/setup') {
    if (!ctx.config.setupSecret) return loginPage(next, { notConfigured: true, brand: ctx.config.botName });
    let form;
    try { form = await request.formData(); } catch { return new Response('Bad Request', { status: 400 }); }
    const target = form.get('next') === '/status' ? '/status' : '/setup';
    if (!timingSafeEqual(String(form.get('secret') || ''), ctx.config.setupSecret)) {
      if (await tooManyFailures(ctx, request)) return page('Too many attempts', '<div class="banner bad">⛔ Too many failed attempts. Try again in 15 minutes.</div>', 429);
      return loginPage(target, { error: 'Wrong secret.', brand: ctx.config.botName });
    }
    const token = await sessionToken(ctx.config.setupSecret, nowSec() + SESSION_SEC);
    return new Response(null, {
      status: 303,
      headers: { Location: target, 'Set-Cookie': `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_SEC}; HttpOnly; Secure; SameSite=Strict`, 'Cache-Control': 'no-store' },
    });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST' } });

  const auth = await authenticate(request, ctx, next);
  if (!auth.ok) return auth.response;

  if (path === '/status') {
    const report = await runStatus(ctx, request);
    if (url.searchParams.get('format') === 'json') {
      return new Response(JSON.stringify({ ok: report.ok, sections: report.sections }, null, 2), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
    }
    return renderReport(report, { title: `${ctx.config.botName.toUpperCase()} — STATUS`, footer: '<p class="sub">Reload to refresh. Use <code>/status?format=json</code> for monitoring.</p>' });
  }

  const report = await runSetup(ctx, request);
  return renderReport(report, { title: `${ctx.config.botName.toUpperCase()} — SYSTEM INITIALIZATION`, footer: '<p class="sub">Safe to open again at any time: setup is idempotent and never deletes data.</p>' });
}
