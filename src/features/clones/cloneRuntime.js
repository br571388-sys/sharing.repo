// Runs one clone bot. Every clone uses this same code, with its own token, its own Turso database, its own owner and
// its own name. Each clone's webhook is <base>/webhook/clone/<id>, protected by that clone's own secret.
import { createContext } from '../../core/bot.js';
import { processUpdate } from '../../core/webhook.js';
import { decryptSecret } from '../../core/cloneCrypto.js';
import { getCloneSecrets, updateClone } from '../../database/clones.js';
import { getBotSetting } from '../../database/settings.js';
import { Telegram } from '../../services/telegram.js';
import { Cache } from '../../services/cache.js';
import { timingSafeEqual, nowSec } from '../../utils/helpers.js';
import { MAINTENANCE_TEXT } from '../../core/maintenance.js';
import { box } from '../../ui/design.js';
import { bumpUsage } from '../../database/roles.js';

export const CLONE_PATH = /^\/webhook\/clone\/(\d+)$/;

/** Decrypts a clone's secrets. Throws when the key is wrong; never returns partial data. */
export async function cloneSecrets(config, row) {
  return {
    token: await decryptSecret(config.cloneKey, row.token_enc),
    dbToken: row.db_token_enc ? await decryptSecret(config.cloneKey, row.db_token_enc) : '',
    webhookSecret: await decryptSecret(config.cloneKey, row.webhook_secret_enc),
  };
}

/**
 * Context for one clone: the same handlers, but the clone's token, database, owner, name and identity.
 * Shared resources are never used: no shared KV cache (file ids are bot-specific) and no shared backup storage.
 */
export function buildCloneContext(mainCtx, clone, secrets, cloneDb = null) {
  const base = mainCtx.config;
  const config = {
    ...base,
    botToken: secrets.token,
    turso: { url: clone.db_url, token: secrets.dbToken },
    ownerId: Number(clone.owner_user_id),
    botName: clone.bot_name,
    botSlug: `clone-${clone.id}`,
    webhookSecret: secrets.webhookSecret,
    isClone: true,
    mainOwnerId: base.ownerId,
  };
  const ctx = createContext(mainCtx.env, mainCtx.executionCtx, {
    config,
    // Failed API calls are counted in this clone's own database, never in the main bot's.
    tg: new Telegram(secrets.token, {
      onFailure: () => ctx.waitUntil(bumpUsage(ctx.db, 'api_fail').catch(() => {})),
    }),
    botInfo: { id: Number(clone.bot_id), username: clone.bot_username || '', first_name: clone.bot_name },
    cache: new Cache({ kv: null, getDb: () => ctx.db }),
    storage: null,
    ...(cloneDb ? { db: cloneDb } : {}),
  });
  ctx.mainTg = mainCtx.tg; // the main bot sends requests to the Main Owner
  ctx.clone = { id: Number(clone.id), ownerId: Number(clone.owner_user_id), broadcastApproved: Boolean(clone.broadcast_approved) };
  return ctx;
}

export async function handleCloneRequest(request, env, executionCtx, overrides = {}) {
  const main = createContext(env, executionCtx, overrides);
  const m = new URL(request.url).pathname.match(CLONE_PATH);
  if (!m) return new Response('Not Found', { status: 404 });
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });

  const id = Number(m[1]);
  const row = await getCloneSecrets(main.db, id);
  if (!row || row.status === 'removed' || !row.token_enc) return new Response('Not Found', { status: 404 });

  let secrets;
  try { secrets = await cloneSecrets(main.config, row); } catch { return new Response('Forbidden', { status: 403 }); }
  const given = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!secrets.webhookSecret || !timingSafeEqual(given, secrets.webhookSecret)) return new Response('Forbidden', { status: 403 });

  // Stop-all switch from the main owner: Telegram retries later, nothing is processed.
  if ((await getBotSetting(main.db, 'clones_paused', '0')) === '1') return new Response('Service Unavailable', { status: 503, headers: { 'Retry-After': '300' } });

  const raw = await request.text();
  if (raw.length > 512 * 1024) return new Response('Payload Too Large', { status: 413 });
  let update;
  try { update = JSON.parse(raw); } catch { return new Response('Bad Request', { status: 400 }); }

  if (nowSec() - Number(row.last_active_at || 0) > 300) await updateClone(main.db, id, { last_active_at: nowSec() }).catch(() => {});

  const ctx = buildCloneContext(main, row, secrets);
  const mainMaintenance = (await getBotSetting(main.db, 'maintenance', '0')) === '1';
  if (mainMaintenance || row.maintenance) {
    const chat = update.message?.chat;
    if (chat?.type === 'private') await ctx.tg.sendMessage(chat.id, `${box('🛠', 'Under Maintenance')}\n\n${MAINTENANCE_TEXT}`).catch(() => {});
    if (update.callback_query) await ctx.tg.answerCallbackQuery(update.callback_query.id, MAINTENANCE_TEXT, true).catch(() => {});
    return new Response('ok', { status: 200 });
  }
  const work = processUpdate(ctx, update);
  if (executionCtx?.waitUntil) executionCtx.waitUntil(work); else await work;
  return new Response('ok', { status: 200 });
}
