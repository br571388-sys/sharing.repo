// /schedule, /animeschedule, /airing — day / week schedule and next-episode lookup. All times in IST.

import { withFallback } from './provider.js';
import { searchAnime, getAnimeById } from './animeInfo.js';
import { cacheKey } from '../../services/cache.js';
import { esc, messages, field, SEP } from '../../utils/formatter.js';
import { btn, markup } from '../../keyboards/inlineKeyboard.js';
import { chunk, truncate } from '../../utils/helpers.js';
import {
  formatCountdown, formatDateTimeIST, formatDayIST, formatShortDayIST, formatTimeIST, istDayRange, istDayStart,
} from '../../services/timezone.js';
import { reply, safeEdit, reactOk } from '../../handlers/helpers.js';
import { userErrorMessage } from '../../core/errorHandler.js';
import { boxHtml } from '../../ui/design.js';

const PAGE_SIZE = 10;
const title = (m) => m?.title?.english || m?.title?.romaji || 'Unknown';

/** Raw (cached) entries airing on IST day `offset` (0 = today). Countdowns are NOT stored. */
export async function loadDay(ctx, offset) {
  const { from, to } = istDayRange(offset);
  const { value } = await ctx.cache.remember(cacheKey('sched', 'day', from), ctx.config.ttl.schedule, async () => {
    const { result } = await withFallback(ctx.config, (p) => p.daySchedule(from, to), { isEmpty: (r) => !r.length });
    const entries = result
      .filter((e) => e.media && !e.media.isAdult && e.airingAt >= from && e.airingAt < to)
      .map((e) => ({ airingAt: e.airingAt, episode: e.episode, title: title(e.media) }));
    return entries.length ? entries : null;
  });
  return value || [];
}

/** Popular currently-airing shows whose next episode falls within the coming 7 IST days. */
export async function loadWeek(ctx) {
  const start = istDayStart();
  const { value } = await ctx.cache.remember(cacheKey('sched', 'week', start), ctx.config.ttl.schedule, async () => {
    const { result } = await withFallback(ctx.config, (p) => p.releasing(2), { isEmpty: (r) => !r.length });
    const entries = result
      .filter((m) => !m.isAdult && m.nextAiringEpisode?.airingAt >= start && m.nextAiringEpisode.airingAt < start + 7 * 86400)
      .map((m) => ({ airingAt: m.nextAiringEpisode.airingAt, episode: m.nextAiringEpisode.episode, title: title(m) }));
    return entries.length ? entries : null;
  });
  return value || [];
}

const dayName = (offset, ts) => (offset === 0 ? "Today's Episodes" : offset === 1 ? "Tomorrow's Episodes" : `${formatDayIST(ts)} Episodes`);

function navRow(active) {
  const mk = (label, data, key) => btn(active === key ? `• ${label} •` : label, data);
  return [mk('📅 Today', 'sc:d:0:0', 'd0'), mk('🌅 Tomorrow', 'sc:d:1:0', 'd1'), mk('🗓 Week', 'sc:w', 'w')];
}

export function renderDay(offset, entries, page, now = Math.floor(Date.now() / 1000)) {
  const { from } = istDayRange(offset, now);
  const header = `${boxHtml("📅", "Anime Airing Schedule")}\n\n🌸 <b>${esc(dayName(offset, from))}</b> — ${esc(formatDayIST(from))}`;
  const footer = '🕒 All times are displayed in Asia/Kolkata (IST).';
  if (!entries.length) {
    return { text: `${header}\n\n📭 No episodes are scheduled for this day.\n\n${footer}`, keyboard: markup([navRow(`d${offset}`)]) };
  }
  const pages = chunk(entries, PAGE_SIZE);
  const p = Math.min(Math.max(page, 0), pages.length - 1);
  const body = pages[p].map((e, i) => [
    `${p * PAGE_SIZE + i + 1}. 🎬 <b>${esc(truncate(e.title, 60))}</b>`,
    `   📺 Episode: ${String(e.episode).padStart(2, '0')}`,
    `   ⏰ Airing: ${esc(formatTimeIST(e.airingAt))}${e.airingAt < now ? ' ✔️' : ''}`,
  ].join('\n')).join('\n\n');
  const pager = pages.length > 1 ? [
    btn('⬅️ Prev', `sc:d:${offset}:${Math.max(p - 1, 0)}`),
    btn(`${p + 1}/${pages.length}`, 'sc:noop'),
    btn('Next ➡️', `sc:d:${offset}:${Math.min(p + 1, pages.length - 1)}`),
  ] : null;
  return {
    text: `${header}  <i>(${entries.length} total)</i>\n\n${body}\n\n${footer}`,
    keyboard: markup([...(pager ? [pager] : []), navRow(`d${offset}`)]),
  };
}

export function renderWeek(entries, now = Math.floor(Date.now() / 1000)) {
  const start = istDayStart(now);
  const header = `${boxHtml("📅", "Anime Airing Schedule")}\n\n🗓 <b>This Week</b> — popular airing shows`;
  const footer = '🕒 All times are displayed in Asia/Kolkata (IST).';
  if (!entries.length) return { text: `${header}\n\n📭 The weekly schedule is unavailable right now.\n\n${footer}`, keyboard: markup([navRow('w')]) };

  const sections = [];
  for (let d = 0; d < 7; d++) {
    const dayEntries = entries.filter((e) => e.airingAt >= start + d * 86400 && e.airingAt < start + (d + 1) * 86400).sort((a, b) => a.airingAt - b.airingAt);
    if (!dayEntries.length) continue;
    const shown = dayEntries.slice(0, 6).map((e) => `• ${esc(formatTimeIST(e.airingAt).replace(' IST', ''))} — ${esc(truncate(e.title, 40))} <i>(Ep ${e.episode})</i>`);
    if (dayEntries.length > 6) shown.push(`<i>…and ${dayEntries.length - 6} more</i>`);
    sections.push(`${d === 0 ? '🌸 <b>Today</b>' : d === 1 ? '🌅 <b>Tomorrow</b>' : `📆 <b>${esc(formatDayIST(start + d * 86400))}</b>`}\n${shown.join('\n')}`);
  }
  const dayButtons = Array.from({ length: 7 }, (_, d) => btn(formatShortDayIST(start + d * 86400), `sc:d:${d}:0`));
  return {
    text: `${header}\n\n${sections.join('\n\n')}\n\n${footer}`,
    keyboard: markup([...chunk(dayButtons, 4), navRow('w')]),
  };
}

/** Message for one anime's next episode. Countdown is computed now, never stored. */
export function renderNextEpisode(media, now = Math.floor(Date.now() / 1000)) {
  const name = media.titleEnglish || media.titleRomaji || media.titleNative;
  const head = `${boxHtml("📅", "Next Episode")}\n\n${field('🎬', 'Anime', name)}`;
  if (media.next && media.next.airingAt > now) {
    return [
      head,
      field('📺', 'Episode', media.next.episode),
      field('📆', 'Date', formatDayIST(media.next.airingAt)),
      field('⏰', 'Time', formatTimeIST(media.next.airingAt)),
      field('⏳', 'Airs in', formatCountdown(media.next.airingAt, now)),
      '',
      `🕒 ${esc(formatDateTimeIST(media.next.airingAt))}`,
      SEP,
      `🔎 <b>Source:</b> ${esc(media.source)}`,
    ].join('\n');
  }
  const why = media.status === 'FINISHED' ? '✅ This anime has finished airing.'
    : media.status === 'NOT_YET_RELEASED' ? '🕐 This anime has not been released yet — its schedule is unavailable.'
      : media.status === 'CANCELLED' ? '🚫 This anime was cancelled.'
        : '❔ The next episode schedule is unavailable.';
  return `${head}\n\n${why}\n\n${SEP}\n🔎 <b>Source:</b> ${esc(media.source)}`;
}

async function nextEpisodeFor(ctx, query) {
  const found = await searchAnime(ctx, query);
  const results = found.results.filter((m) => !m.isAdult);
  if (!results.length) return null;
  let media = results.find((m) => m.next) || results[0];
  const now = Math.floor(Date.now() / 1000);
  // A cached "next episode" that already aired is stale: refetch it fresh.
  if (media.next && media.next.airingAt <= now && media.id) {
    const fresh = await getAnimeFresh(ctx, media);
    if (fresh) media = fresh;
  }
  return media;
}

async function getAnimeFresh(ctx, media) {
  try {
    const { providers } = await import('./provider.js');
    const provider = providers(ctx.config).find((p) => p.name === media.source);
    return provider ? await provider.byId(media.id) : null;
  } catch {
    return null;
  }
}

export async function scheduleCommand(ctx, msg, args) {
  const arg = args.trim();
  const lower = arg.toLowerCase();
  const loading = await reply(ctx, msg, messages.searching('📅', 'Fetching the airing schedule...'));
  const edit = (view) => safeEdit(ctx, msg.chat.id, loading.message_id, view.text, { reply_markup: view.keyboard });

  try {
    if (!arg || ['today', 'tdy'].includes(lower)) await edit(renderDay(0, await loadDay(ctx, 0), 0));
    else if (['tomorrow', 'tmr', 'tmrw'].includes(lower)) await edit(renderDay(1, await loadDay(ctx, 1), 0));
    else if (['week', 'weekly', 'w'].includes(lower)) await edit(renderWeek(await loadWeek(ctx)));
    else {
      if (arg.length > 100) return await safeEdit(ctx, msg.chat.id, loading.message_id, messages.warning('Query Too Long', 'Please use an anime name of at most 100 characters.'));
      const media = await nextEpisodeFor(ctx, arg);
      if (!media) return await safeEdit(ctx, msg.chat.id, loading.message_id, messages.notFound(`No anime found for “${arg}”.`));
      await safeEdit(ctx, msg.chat.id, loading.message_id, renderNextEpisode(media), { reply_markup: markup([navRow('')]) });
    }
    await reactOk(ctx, msg, '⚡');
  } catch (e) {
    await safeEdit(ctx, msg.chat.id, loading.message_id, userErrorMessage(e));
    throw e;
  }
  return undefined;
}

/** Callbacks: sc:d:<offset>:<page>, sc:w, sc:noop */
export async function scheduleCallback(ctx, cq, parts) {
  if (parts[1] === 'noop') return ctx.tg.answerCallbackQuery(cq.id);
  const { chat, message_id: messageId } = cq.message;
  let view;
  try {
    if (parts[1] === 'w') view = renderWeek(await loadWeek(ctx));
    else {
      const offset = Number(parts[2]);
      const page = Number(parts[3] || 0);
      if (!Number.isInteger(offset) || offset < 0 || offset > 6 || !Number.isInteger(page) || page < 0) return await ctx.tg.answerCallbackQuery(cq.id, 'Invalid button.');
      view = renderDay(offset, await loadDay(ctx, offset), page);
    }
  } catch (e) {
    return ctx.tg.answerCallbackQuery(cq.id, 'The schedule service is unavailable right now. Try again later.', true);
  }
  await ctx.tg.answerCallbackQuery(cq.id);
  await safeEdit(ctx, chat.id, messageId, view.text, { reply_markup: view.keyboard });
  return undefined;
}
