// /anime, /animeinfo — anime information card (Taizen primary, AniList fallback, cached).

import { withFallback, providers } from './provider.js';
import { cacheKey } from '../../services/cache.js';
import { esc, messages, field, SEP } from '../../utils/formatter.js';
import { truncate } from '../../utils/helpers.js';
import { formatDayIST, formatTimeIST, formatCountdown } from '../../services/timezone.js';
import { btn, markup, urlBtn } from '../../keyboards/inlineKeyboard.js';
import { reply, safeEdit, safeEditCaption, reactOk, visibleLength } from '../../handlers/helpers.js';
import { ApiError } from '../../utils/errors.js';
import { userErrorMessage } from '../../core/errorHandler.js';
import { isMessageNotModified } from '../../services/telegram.js';

const STATUS = {
  FINISHED: 'Finished Airing', RELEASING: 'Currently Airing', NOT_YET_RELEASED: 'Not Yet Released',
  CANCELLED: 'Cancelled', HIATUS: 'On Hiatus',
};
const SEASON = { WINTER: 'Winter', SPRING: 'Spring', SUMMER: 'Summer', FALL: 'Fall' };
const CAPTION_LIMIT = 1000;
const SRC_CODE = { Taizen: 'T', AniList: 'A' };
const CODE_SRC = { T: 'Taizen', A: 'AniList' };

/** Searches anime (cached). Returns { results, source }. Throws ApiError when every provider failed. */
export async function searchAnime(ctx, query) {
  const key = cacheKey('anime', 's', query);
  const { value } = await ctx.cache.remember(key, ctx.config.ttl.anime, async () => {
    const { result, source } = await withFallback(ctx.config, (p) => p.search(query, 5), { isEmpty: (r) => !r.length });
    const payload = { results: result, source };
    // Cache each hit by id so the "other results" buttons are instant.
    await Promise.all(result.filter((m) => m.id).map((m) => ctx.cache.set(cacheKey('anime', 'm', m.source, m.id), m, ctx.config.ttl.anime)));
    return result.length ? payload : null; // never cache "no results"
  });
  return value || { results: [], source: null };
}

export async function getAnimeById(ctx, sourceName, id) {
  const key = cacheKey('anime', 'm', sourceName, id);
  const { value } = await ctx.cache.remember(key, ctx.config.ttl.anime, async () => {
    const provider = providers(ctx.config).find((p) => p.name === sourceName);
    return provider ? provider.byId(id) : null;
  });
  return value;
}

/** Builds the anime card caption (HTML, <= ~1000 visible chars so it fits a photo caption). */
export function buildAnimeCaption(m, now = Math.floor(Date.now() / 1000)) {
  const lines = [`🎬 <b>Anime Information</b>`, ''];
  lines.push(field('📌', 'Title', m.titleEnglish || m.titleRomaji || m.titleNative));
  if (m.titleEnglish && m.titleRomaji && m.titleRomaji !== m.titleEnglish) lines.push(field('🔤', 'Romaji', m.titleRomaji));
  if (m.titleNative) lines.push(field('🈶', 'Japanese', m.titleNative));
  if (m.score !== null) lines.push(field('⭐', 'Rating', `${m.score.toFixed(1)}/10`));
  if (m.year || m.season) lines.push(field('📅', 'Year', [m.year, m.season ? `(${SEASON[m.season] || m.season})` : ''].filter(Boolean).join(' ')));
  if (m.genres.length) lines.push(field('🎭', 'Genres', m.genres.slice(0, 6).join(', ')));
  if (m.episodes) lines.push(field('📺', 'Episodes', m.episodes));
  if (m.duration) lines.push(field('⏱', 'Duration', `${m.duration} min/ep`));
  if (m.status) lines.push(field('📡', 'Status', STATUS[m.status] || m.status));
  if (m.studios.length) lines.push(field('🏢', m.studios.length > 1 ? 'Studios' : 'Studio', m.studios.slice(0, 3).join(', ')));
  if (m.sourceMaterial) lines.push(field('📖', 'Source Material', m.sourceMaterial.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())));
  if (m.next && m.next.airingAt > now) {
    lines.push(field('⏭', 'Next Episode', `Ep ${m.next.episode} • ${formatDayIST(m.next.airingAt)}, ${formatTimeIST(m.next.airingAt)} (in ${formatCountdown(m.next.airingAt, now)})`));
  }

  const footer = `\n${SEP}\n🔎 <b>Source:</b> ${esc(m.source || 'Unknown')}`;
  const head = lines.join('\n');
  if (m.description) {
    let budget = CAPTION_LIMIT - visibleLength(head) - visibleLength(footer) - 20;
    if (budget > 80) {
      const syn = truncate(m.description.replace(/\s+/g, ' '), budget);
      return `${head}\n\n📝 <b>Synopsis:</b>\n${esc(syn)}${footer}`;
    }
  }
  return `${head}${footer}`;
}

function cardKeyboard(media, others) {
  const rows = [];
  if (others.length) {
    rows.push(...others.slice(0, 3).map((o) => [btn(`🔁 ${truncate(o.titleEnglish || o.titleRomaji || o.titleNative, 30)}`, `an:${SRC_CODE[o.source] || 'A'}:${o.id}`)]));
  }
  if (media.url) rows.push([urlBtn('🔗 Open Page', media.url)]);
  return rows.length ? markup(rows) : undefined;
}

export async function animeCommand(ctx, msg, args) {
  const query = args.trim();
  if (!query) {
    return reply(ctx, msg, messages.usage(['/anime <anime name>'], ['/anime Frieren', '/animeinfo One Piece']));
  }
  if (query.length > 100) return reply(ctx, msg, messages.warning('Query Too Long', 'Please use an anime name of at most 100 characters.'));

  const loading = await reply(ctx, msg, messages.searching('🔎', 'Searching for anime...'));
  let found;
  try {
    found = await searchAnime(ctx, query);
  } catch (e) {
    await safeEdit(ctx, msg.chat.id, loading.message_id, e instanceof ApiError ? userErrorMessage(e) : messages.unavailable());
    throw e;
  }

  if (!found.results.length) {
    return safeEdit(ctx, msg.chat.id, loading.message_id, messages.notFound(`No anime found for “${query}”.`, 'Check the spelling or try the original (romaji) title.'));
  }

  const results = found.results.filter((m) => !m.isAdult);
  if (!results.length) return safeEdit(ctx, msg.chat.id, loading.message_id, messages.notFound('No matching anime to show.'));
  const [top, ...others] = results;
  const caption = buildAnimeCaption(top);
  const keyboard = cardKeyboard(top, others);

  if (top.cover) {
    try {
      await ctx.tg.sendPhoto(msg.chat.id, top.cover, {
        caption, ...(keyboard ? { reply_markup: keyboard } : {}),
        ...(msg.chat.type === 'private' ? {} : { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } }),
      });
      await ctx.tg.deleteMessage(msg.chat.id, loading.message_id).catch(() => {});
      await reactOk(ctx, msg, '🔥');
      return undefined;
    } catch {
      // cover could not be fetched by Telegram: fall through to a text card
    }
  }
  await safeEdit(ctx, msg.chat.id, loading.message_id, caption, keyboard ? { reply_markup: keyboard } : {});
  await reactOk(ctx, msg, '🔥');
  return undefined;
}

/** Callback "an:<T|A>:<id>" — switch the card to another search result. */
export async function animeCallback(ctx, cq, parts) {
  const sourceName = CODE_SRC[parts[1]];
  const id = Number(parts[2]);
  if (!sourceName || !Number.isInteger(id)) return ctx.tg.answerCallbackQuery(cq.id, 'Invalid button.');
  const media = await getAnimeById(ctx, sourceName, id);
  if (!media) return ctx.tg.answerCallbackQuery(cq.id, 'Could not load this anime right now.', true);

  const message = cq.message;
  const caption = buildAnimeCaption(media);
  // Keep the alternative-result buttons from the original keyboard; only the link row changes.
  const kept = (message.reply_markup?.inline_keyboard || []).filter((row) => row.every((b) => String(b.callback_data || '').startsWith('an:')));
  const keyboard = markup([...kept, ...(media.url ? [[urlBtn('🔗 Open Page', media.url)]] : [])]);
  await ctx.tg.answerCallbackQuery(cq.id);
  try {
    if (message.photo) {
      if (media.cover) await ctx.tg.editMessageMedia(message.chat.id, message.message_id, { type: 'photo', media: media.cover, caption, parse_mode: 'HTML' }, { reply_markup: keyboard });
      else await safeEditCaption(ctx, message.chat.id, message.message_id, caption, { reply_markup: keyboard });
    } else {
      await safeEdit(ctx, message.chat.id, message.message_id, caption, { reply_markup: keyboard });
    }
  } catch (e) {
    if (!isMessageNotModified(e)) throw e;
  }
  return undefined;
}
