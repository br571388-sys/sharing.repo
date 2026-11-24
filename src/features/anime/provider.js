// Provider orchestration: primary provider first, the other as fallback. Results are cached by the callers.

import { createAnilist } from './anilist.js';
import { createTaizen } from './taizen.js';
import { ApiError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

export function providers(config) {
  const taizen = createTaizen(config.anime.taizenUrl);
  const anilist = createAnilist(config.anime.anilistUrl);
  return config.anime.primary === 'anilist' ? [anilist, taizen] : [taizen, anilist];
}

/**
 * Runs `fn(provider)` against each provider in order until one returns a usable result.
 * `isEmpty(result)` lets an empty result also trigger the fallback (e.g. Taizen found nothing, AniList might).
 */
export async function withFallback(config, fn, { isEmpty = (r) => !r } = {}) {
  let lastError = null;
  let firstEmpty = null;
  for (const provider of providers(config)) {
    try {
      const result = await fn(provider);
      if (!isEmpty(result)) return { result, source: provider.name };
      firstEmpty = firstEmpty || { result, source: provider.name };
    } catch (e) {
      lastError = e;
      logger.warn(`${provider.name} failed: ${e?.message}`);
    }
  }
  if (firstEmpty) return firstEmpty;
  throw lastError instanceof ApiError ? lastError : new ApiError('All anime providers failed', { cause: lastError });
}
