// GraphQL transport + response normalisation shared by the Taizen and AniList clients.

import { ApiError } from '../../utils/errors.js';
import { fetchWithTimeout } from '../../utils/helpers.js';

export async function gqlRequest(url, query, variables = {}, { timeoutMs = 8000, label = 'anime API' } = {}) {
  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'TelegramWorkersBot/1.0' },
      body: JSON.stringify({ query, variables }),
    }, timeoutMs);
  } catch (e) {
    throw new ApiError(`${label} unreachable: ${e?.name === 'AbortError' ? 'timeout' : e?.message}`, { code: 'api_unreachable', cause: e });
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after')) || 30;
    throw new ApiError(`${label} rate limited`, { code: 'rate_limited', retryAfter, userMessage: 'The anime service is busy right now. Please try again in a minute.' });
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new ApiError(`${label} returned a non-JSON response (HTTP ${res.status})`, { code: 'api_malformed' });
  }
  if (!res.ok || (json.errors?.length && !json.data)) {
    const msg = json?.errors?.[0]?.message || `HTTP ${res.status}`;
    throw new ApiError(`${label} error: ${msg}`, { code: res.status === 404 ? 'not_found' : 'api_error' });
  }
  if (!json.data) throw new ApiError(`${label} returned no data`, { code: 'api_malformed' });
  return json.data;
}

const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');

export function stripHtml(text) {
  return String(text ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Normalises an AniList-shaped media object (tolerates missing fields). Returns null if unusable. */
export function normalizeMedia(raw, source) {
  if (!raw || typeof raw !== 'object') return null;
  const titles = typeof raw.title === 'object' && raw.title ? raw.title : { romaji: typeof raw.title === 'string' ? raw.title : undefined };
  const english = pick(titles.english, titles.userPreferred);
  const romaji = pick(titles.romaji, titles.userPreferred);
  const native = titles.native;
  if (!english && !romaji && !native) return null;

  const cover = typeof raw.coverImage === 'string' ? raw.coverImage : pick(raw.coverImage?.extraLarge, raw.coverImage?.large, raw.coverImage?.medium);
  const score = pick(raw.averageScore, raw.meanScore, typeof raw.score === 'number' ? raw.score * 10 : undefined);
  const next = raw.nextAiringEpisode && raw.nextAiringEpisode.airingAt
    ? { airingAt: Number(raw.nextAiringEpisode.airingAt), episode: Number(raw.nextAiringEpisode.episode) }
    : null;
  const studios = (raw.studios?.nodes || raw.studios || []).map((s) => (typeof s === 'string' ? s : s?.name)).filter(Boolean);

  return {
    id: pick(raw.id, raw.idMal),
    source,
    titleEnglish: english || null,
    titleRomaji: romaji || null,
    titleNative: native || null,
    cover: typeof cover === 'string' && /^https?:\/\//.test(cover) ? cover : null,
    description: raw.description ? stripHtml(raw.description) : null,
    score: Number.isFinite(Number(score)) && Number(score) > 0 ? Math.round(Number(score)) / 10 : null,
    genres: Array.isArray(raw.genres) ? raw.genres.filter(Boolean) : [],
    status: raw.status || null,
    year: pick(raw.seasonYear, raw.startDate?.year) ?? null,
    season: raw.season || null,
    episodes: raw.episodes ?? null,
    duration: raw.duration ?? null,
    studios,
    sourceMaterial: raw.source || null,
    format: raw.format || null,
    next,
    url: typeof raw.siteUrl === 'string' && /^https?:\/\//.test(raw.siteUrl) ? raw.siteUrl : null,
    isAdult: Boolean(raw.isAdult),
  };
}

// Field selection shared by every query (AniList schema; Taizen is queried with the same shape).
export const MEDIA_FIELDS = `
  id idMal
  title { romaji english native }
  coverImage { extraLarge large }
  description(asHtml: false)
  averageScore meanScore genres status seasonYear season
  startDate { year }
  episodes duration source format isAdult siteUrl
  studios(isMain: true) { nodes { name } }
  nextAiringEpisode { airingAt episode }
`;

export const SEARCH_QUERY = `
query ($search: String!, $perPage: Int!) {
  Page(page: 1, perPage: $perPage) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH) { ${MEDIA_FIELDS} }
  }
}`;

export const BY_ID_QUERY = `query ($id: Int!) { Media(id: $id, type: ANIME) { ${MEDIA_FIELDS} } }`;

export const DAY_SCHEDULE_QUERY = `
query ($from: Int!, $to: Int!, $page: Int!) {
  Page(page: $page, perPage: 50) {
    pageInfo { hasNextPage }
    airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
      airingAt episode
      media { id title { romaji english } siteUrl isAdult format }
    }
  }
}`;

export const RELEASING_QUERY = `
query ($page: Int!) {
  Page(page: $page, perPage: 50) {
    pageInfo { hasNextPage }
    media(type: ANIME, status: RELEASING, sort: POPULARITY_DESC) {
      id title { romaji english } siteUrl isAdult format
      nextAiringEpisode { airingAt episode }
    }
  }
}`;
