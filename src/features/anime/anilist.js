// AniList GraphQL client (https://docs.anilist.co) — used as the fallback provider (or primary if configured).

import { BY_ID_QUERY, DAY_SCHEDULE_QUERY, RELEASING_QUERY, SEARCH_QUERY, gqlRequest, normalizeMedia } from './graphql.js';

export const name = 'AniList';

export function createAnilist(url) {
  const call = (query, variables) => gqlRequest(url, query, variables, { label: 'AniList' });
  return {
    name,
    async search(text, perPage = 5) {
      const data = await call(SEARCH_QUERY, { search: text, perPage });
      return (data.Page?.media || []).map((m) => normalizeMedia(m, name)).filter(Boolean);
    },
    async byId(id) {
      const data = await call(BY_ID_QUERY, { id: Number(id) });
      return normalizeMedia(data.Media, name);
    },
    /** Every non-adult episode airing in [from, to) (unix seconds), up to `maxPages` pages. */
    async daySchedule(from, to, maxPages = 6) {
      const out = [];
      for (let page = 1; page <= maxPages; page++) {
        const data = await call(DAY_SCHEDULE_QUERY, { from: from - 1, to, page });
        const items = data.Page?.airingSchedules || [];
        out.push(...items);
        if (!data.Page?.pageInfo?.hasNextPage) break;
      }
      return out;
    },
    /** Currently airing shows by popularity with their next episode (used for the weekly overview). */
    async releasing(maxPages = 2) {
      const out = [];
      for (let page = 1; page <= maxPages; page++) {
        const data = await call(RELEASING_QUERY, { page });
        out.push(...(data.Page?.media || []));
        if (!data.Page?.pageInfo?.hasNextPage) break;
      }
      return out;
    },
  };
}
