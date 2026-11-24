// Taizen GraphQL client (https://taizen.moe/api/graphql) — primary provider.
//
// NOTE: Taizen's schema documentation could not be fetched while this project was generated, so this client
// sends the AniList-style query shape and normalises the response tolerantly. If Taizen rejects a query or
// returns an unexpected shape, provider.js transparently falls back to AniList and logs the reason.
// If Taizen's real field names differ, adjust ONLY the query strings in graphql.js / the mapping below.

import { BY_ID_QUERY, DAY_SCHEDULE_QUERY, RELEASING_QUERY, SEARCH_QUERY, gqlRequest, normalizeMedia } from './graphql.js';

export const name = 'Taizen';

export function createTaizen(url) {
  const call = (query, variables) => gqlRequest(url, query, variables, { label: 'Taizen' });
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
