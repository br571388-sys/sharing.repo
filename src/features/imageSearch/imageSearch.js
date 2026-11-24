// /image, /img, /imagesearch — image search with inline pagination. Providers: Pixabay (key) / Wikimedia Commons.
// Pixabay terms: cache results for 24h (done via CACHE_TTL_IMAGE) and show where images come from (shown in captions).

import { ApiError } from '../../utils/errors.js';
import { esc, field, messages } from '../../utils/formatter.js';
import { fetchWithTimeout, sha256Hex, truncate } from '../../utils/helpers.js';
import { cacheKey } from '../../services/cache.js';
import { btn, markup, urlBtn } from '../../keyboards/inlineKeyboard.js';
import { reply, safeEdit, reactOk } from '../../handlers/helpers.js';
import { userErrorMessage } from '../../core/errorHandler.js';
import { isMessageNotModified } from '../../services/telegram.js';
import { stripHtml } from '../anime/graphql.js';
import { isHttpUrl } from '../../utils/validation.js';

async function getJson(url, label) {
  let res;
  try {
    res = await fetchWithTimeout(url, { headers: { Accept: 'application/json', 'User-Agent': 'TelegramWorkersBot/1.0 (Telegram bot)' } }, 8000);
  } catch (e) {
    throw new ApiError(`${label} unreachable: ${e?.message}`, { code: 'api_unreachable', cause: e });
  }
  if (res.status === 429) throw new ApiError(`${label} rate limited`, { code: 'rate_limited', userMessage: 'Image search is busy right now. Please try again in a minute.' });
  if (res.status === 400 || res.status === 401 || res.status === 403) throw new ApiError(`${label} rejected the request (HTTP ${res.status}) — check the API key`, { code: 'api_auth' });
  if (!res.ok) throw new ApiError(`${label} HTTP ${res.status}`, { code: 'api_error' });
  try { return await res.json(); } catch { throw new ApiError(`${label} returned malformed JSON`, { code: 'api_malformed' }); }
}

/** Provider interface: { name, available(config), search(config, query) -> [{url, pageUrl, title, author, license}] } */
export const imageProviders = {
  pixabay: {
    name: 'Pixabay',
    available: (config) => Boolean(config.image.pixabayKey),
    async search(config, query) {
      const url = new URL(config.image.pixabayUrl);
      url.searchParams.set('key', config.image.pixabayKey);
      url.searchParams.set('q', query.slice(0, 100));
      url.searchParams.set('image_type', 'photo');
      url.searchParams.set('safesearch', 'true');
      url.searchParams.set('per_page', '20');
      const json = await getJson(url.toString(), 'Pixabay');
      return (json.hits || [])
        .map((h) => ({
          url: h.webformatURL || h.largeImageURL, pageUrl: h.pageURL,
          title: h.tags || query, author: h.user || null, license: 'Pixabay License',
        }))
        .filter((r) => isHttpUrl(r.url));
    },
  },
  wikimedia: {
    name: 'Wikimedia Commons',
    available: () => true,
    async search(config, query) {
      const url = new URL(config.image.wikimediaUrl);
      const p = {
        action: 'query', generator: 'search', gsrsearch: `${query.slice(0, 100)} filetype:bitmap`, gsrnamespace: '6', gsrlimit: '20',
        prop: 'imageinfo', iiprop: 'url|mime|extmetadata', iiurlwidth: '900', format: 'json', formatversion: '2', origin: '*',
      };
      for (const [k, v] of Object.entries(p)) url.searchParams.set(k, v);
      const json = await getJson(url.toString(), 'Wikimedia');
      const rawPages = json.query?.pages || [];
      const pages = (Array.isArray(rawPages) ? rawPages : Object.values(rawPages)).sort((a, b) => (a.index || 0) - (b.index || 0));
      return pages.map((pg) => {
        const info = pg.imageinfo?.[0];
        if (!info || !/^image\/(jpeg|png|webp)$/.test(info.mime || '')) return null;
        const meta = info.extmetadata || {};
        return {
          url: info.thumburl || info.url, pageUrl: info.descriptionurl,
          title: stripHtml(meta.ObjectName?.value || pg.title?.replace(/^File:/, '') || query),
          author: stripHtml(meta.Artist?.value || '') || null, license: stripHtml(meta.LicenseShortName?.value || '') || 'See source page',
        };
      }).filter((r) => r && isHttpUrl(r.url));
    },
  },
};

function pickProvider(config) {
  const wanted = imageProviders[config.image.provider] || imageProviders.pixabay;
  return wanted.available(config) ? wanted : imageProviders.wikimedia;
}

/** Cached search. Returns { token, results, provider }. */
export async function searchImages(ctx, query) {
  const provider = pickProvider(ctx.config);
  const token = (await sha256Hex(`${provider.name}|${query.toLowerCase()}`)).slice(0, 12);
  const key = cacheKey('img', token);
  const { value } = await ctx.cache.remember(key, ctx.config.ttl.image, async () => {
    const results = await provider.search(ctx.config, query);
    return results.length ? { query, provider: provider.name, results } : null;
  });
  return value ? { token, ...value } : { token, query, provider: provider.name, results: [] };
}

export function buildCaption(data, index) {
  const r = data.results[index];
  const lines = [
    '🔎 <b>Image Search Results</b>',
    '',
    field('🖼', 'Search', truncate(data.query, 80)),
    field('📌', 'Result', `${index + 1} of ${data.results.length}`),
  ];
  if (r.title) lines.push(field('🏷', 'Tags', truncate(r.title, 100)));
  if (r.author) lines.push(field('👤', 'By', `${truncate(r.author, 60)} — ${data.provider}`));
  else lines.push(field('📡', 'Source', data.provider));
  if (r.license) lines.push(field('📜', 'License', truncate(r.license, 40)));
  return lines.join('\n');
}

export function buildKeyboard(data, token, index) {
  const total = data.results.length;
  const r = data.results[index];
  const nav = [];
  if (total > 1) {
    nav.push(btn('⬅️ Previous', `img:${token}:${(index - 1 + total) % total}`));
    nav.push(btn('Next ➡️', `img:${token}:${(index + 1) % total}`));
  }
  return markup([nav, r.pageUrl ? [urlBtn('🔗 Open Original', r.pageUrl)] : []]);
}

export async function imageCommand(ctx, msg, args) {
  const query = args.trim();
  if (!query) return reply(ctx, msg, messages.usage(['/image <search term>'], ['/image sunset', '/img mountain lake']));
  if (query.length > 100) return reply(ctx, msg, messages.warning('Query Too Long', 'Please use a search term of at most 100 characters.'));

  const loading = await reply(ctx, msg, messages.searching('🔎', 'Searching for images...'));
  let data;
  try {
    data = await searchImages(ctx, query);
  } catch (e) {
    await safeEdit(ctx, msg.chat.id, loading.message_id, userErrorMessage(e));
    throw e;
  }
  if (!data.results.length) {
    return safeEdit(ctx, msg.chat.id, loading.message_id, messages.notFound(`No images found for “${query}”.`, 'Try a different or more general search term.'));
  }

  // Telegram has to download the image itself; if one URL fails, try the next few.
  for (let i = 0; i < Math.min(3, data.results.length); i++) {
    try {
      await ctx.tg.sendPhoto(msg.chat.id, data.results[i].url, {
        caption: buildCaption(data, i), reply_markup: buildKeyboard(data, data.token, i),
        ...(msg.chat.type === 'private' ? {} : { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } }),
      });
      await ctx.tg.deleteMessage(msg.chat.id, loading.message_id).catch(() => {});
      await reactOk(ctx, msg, '🔥');
      return undefined;
    } catch { /* try the next result */ }
  }
  return safeEdit(ctx, msg.chat.id, loading.message_id, messages.unavailable('The image service returned pictures Telegram could not load. Please try again.'));
}

/** Callback: img:<token>:<index> */
export async function imageCallback(ctx, cq, parts) {
  const token = parts[1];
  const index = Number(parts[2]);
  if (!/^[a-f0-9]{12}$/.test(token || '') || !Number.isInteger(index) || index < 0) return ctx.tg.answerCallbackQuery(cq.id, 'Invalid button.');
  const data = await ctx.cache.get(cacheKey('img', token));
  if (!data || index >= data.results.length) return ctx.tg.answerCallbackQuery(cq.id, 'This search has expired. Run /image again.', true);

  await ctx.tg.answerCallbackQuery(cq.id);
  const m = cq.message;
  try {
    await ctx.tg.editMessageMedia(m.chat.id, m.message_id, { type: 'photo', media: data.results[index].url, caption: buildCaption(data, index), parse_mode: 'HTML' }, { reply_markup: buildKeyboard(data, token, index) });
  } catch (e) {
    if (!isMessageNotModified(e)) throw e;
  }
  return undefined;
}
