// Per-request application context: wires config, Telegram client, database, cache and storage together.

import { loadConfig } from './config.js';
import { Telegram } from '../services/telegram.js';
import { Cache } from '../services/cache.js';
import { Storage } from '../services/storage.js';
import { createDb } from '../database/turso.js';
import { bumpUsage } from '../database/roles.js';
import { registerSecrets } from '../utils/logger.js';

const botInfoByToken = new Map(); // per isolate; a bot's identity never changes for its token (main bot and every clone)

/**
 * Builds the context object passed to every handler.
 * `overrides` lets tests inject a fake db / telegram client.
 */
export function createContext(env, executionCtx = null, overrides = {}) {
  // A clone bot is served with its own config (token, database, owner, name); everything else is shared code.
  const config = overrides.config || loadConfig(env);
  registerSecrets([config.botToken, config.turso.token, config.webhookSecret, config.setupSecret, config.image.pixabayKey]);

  let db = overrides.db || null;

  const ctx = {
    env,
    config,
    executionCtx,
    tg: overrides.tg || new Telegram(config.botToken, {
      // Every final Telegram API failure is counted per day in this bot's own usage table (kind 'api_fail').
      onFailure: () => ctx.waitUntil(bumpUsage(ctx.db, 'api_fail').catch(() => {})),
    }),
    storage: overrides.storage || new Storage(overrides.config ? null : env.BACKUPS || null),
    get db() {
      if (!db) db = createDb(config);
      return db;
    },
    waitUntil(promise) {
      if (executionCtx?.waitUntil) executionCtx.waitUntil(promise);
      return promise;
    },
    async botInfo() {
      if (overrides.botInfo) return overrides.botInfo;
      if (!botInfoByToken.has(config.botToken)) botInfoByToken.set(config.botToken, await ctx.tg.getMe());
      return botInfoByToken.get(config.botToken);
    },
  };
  // Clones never use the shared KV cache: Telegram file ids are bot-specific and must not cross bots.
  ctx.cache = overrides.cache || new Cache({ kv: overrides.config ? null : env.CACHE || null, getDb: () => ctx.db });
  return ctx;
}

export function resetBotInfoCache() {
  botInfoByToken.clear();
}
