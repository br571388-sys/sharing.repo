// Cloudflare Worker entry point: HTTP (webhook, /setup, /status, /health, /download), Queue consumer, Cron.

import { createContext } from './core/bot.js';
import { validateConfig } from './core/config.js';
import { handleWebhook } from './core/webhook.js';
import { handleAdminRoute } from './core/setup.js';
import { handleQueueBatch, sweepStaleJobs } from './features/broadcast/queue.js';
import { runAutomaticBackup } from './features/backup/automaticBackup.js';
import { purgeExpired } from './database/state.js';
import { runGroupCron } from './features/groupmgmt/groupCron.js';
import { verifyDownload } from './services/storage.js';
import { logger } from './utils/logger.js';
import { handleCloneRequest, CLONE_PATH } from './features/clones/cloneRuntime.js';
import { runCloneHealth, runCloneGbanJobs } from './features/clones/cloneHealth.js';
import { runCloneBroadcastJobs } from './features/clones/cloneBroadcast.js';

const plain = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

async function handleDownload(request, ctx) {
  const token = new URL(request.url).searchParams.get('t');
  if (!ctx.config.setupSecret || !ctx.storage.configured) return plain('Not Found', 404);
  const key = await verifyDownload(ctx.config.setupSecret, token);
  if (!key) return plain('Link expired or invalid', 403);
  const obj = await ctx.storage.getObject(key);
  if (!obj) return plain('Not Found', 404);
  const name = key.split('/').pop().replace(/[^A-Za-z0-9._-]/g, '_');
  return new Response(obj.body, {
    headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}

export async function handleRequest(request, env, executionCtx, overrides = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  try {
    const ctx = createContext(env, executionCtx, overrides);

    if (path === ctx.config.webhookPath) return await handleWebhook(request, ctx);
    if (CLONE_PATH.test(path) && request.method === 'POST') return await handleCloneRequest(request, env, executionCtx, overrides);
    if (path === '/setup' || path === '/status') return await handleAdminRoute(request, env, executionCtx, overrides);
    if (path === '/download' && request.method === 'GET') return await handleDownload(request, ctx);
    if (path === '/health') return plain(JSON.stringify({ ok: true, service: `${ctx.config.botSlug}-bot` }), 200, { 'Content-Type': 'application/json' });
    if (path === '/' && (request.method === 'GET' || request.method === 'HEAD')) return plain(`${ctx.config.botName} bot is running.`, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return plain('Not Found', 404);
  } catch (err) {
    logger.error(`request failed: ${err?.message}`);
    return plain('Internal Server Error', 500);
  }
}

/** Cron (every minute): automatic backup (when due), stalled-broadcast recovery, group jobs (temporary ban/mute expiry, verification timeouts, delayed deletes), housekeeping. Each job is isolated from the others. */
export async function runScheduled(ctx, now = new Date()) {
  const { errors } = validateConfig(ctx.config);
  if (errors.some((e) => /TURSO|BOT_TOKEN/.test(e))) { logger.warn('scheduled run skipped: configuration incomplete'); return {}; }
  const out = {};
  const job = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = { error: e?.message }; logger.error(`cron ${name} failed: ${e?.message}`); } };
  await job('backup', () => runAutomaticBackup(ctx));
  await job('broadcasts', () => sweepStaleJobs(ctx));
  await job('groups', () => runGroupCron(ctx, now));
  await job('clones', () => runCloneHealth(ctx, now));
  await job('cloneBans', () => runCloneGbanJobs(ctx));
  await job('cloneBroadcasts', () => runCloneBroadcastJobs(ctx));
  if (now.getUTCMinutes() === 0) await job('cleanup', () => purgeExpired(ctx.db));
  return out;
}

export default {
  fetch(request, env, executionCtx) {
    return handleRequest(request, env, executionCtx);
  },
  async queue(batch, env, executionCtx) {
    await handleQueueBatch(batch, createContext(env, executionCtx));
  },
  async scheduled(event, env, executionCtx) {
    executionCtx.waitUntil(runScheduled(createContext(env, executionCtx)));
  },
};
