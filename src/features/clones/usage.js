// Usage = active users / registered users, for the last day, week and month. Each bot (main and every clone)
// has its own users, so the aggregate adds them up across bots. A clone whose database cannot answer is counted
// as "unavailable" instead of being guessed.
import { listClones, getCloneSecrets } from '../../database/clones.js';
import { runMigrations } from '../../database/migrations.js';
import { nowSec } from '../../utils/helpers.js';
import { openCloneDb } from './clonebot.js';

const DAY = 86400;
export const USAGE_PERIODS = [['daily', 'Daily', DAY], ['weekly', 'Weekly', 7 * DAY], ['monthly', 'Monthly', 30 * DAY]];

export const pct = (active, total) => (total > 0 ? Math.round((active / total) * 100) : 0);

/** Usage of one bot database. Returns null when the database cannot answer. heal=true migrates an older clone once. */
export async function usageOf(db, now = nowSec(), { heal = false } = {}) {
  const read = async () => {
    const total = Number(await db.value('SELECT COUNT(*) FROM users', [], 0)) || 0;
    const out = { total: {} };
    for (const [key, , span] of USAGE_PERIODS) {
      const active = Number(await db.value('SELECT COUNT(*) FROM users WHERE last_seen_at >= ?', [now - span], 0)) || 0;
      out[key] = { active, total };
    }
    return out;
  };
  try {
    return await read();
  } catch {
    if (!heal) return null;
    try {
      await runMigrations(db);
      return await read();
    } catch {
      return null;
    }
  }
}

/** Totals for the main bot and every live clone. */
export async function overallUsage(ctx, now = nowSec()) {
  const main = await usageOf(ctx.db, now);
  const clones = [];
  let unavailable = 0;
  for (const c of (await listClones(ctx.db, null)).filter((x) => x.status !== 'removed' && x.status !== 'db_deleted')) {
    try {
      const row = await getCloneSecrets(ctx.db, c.id);
      const u = await usageOf(await openCloneDb(ctx, row), now, { heal: true });
      if (u) clones.push({ id: c.id, name: c.bot_name, usage: u });
      else unavailable++;
    } catch {
      unavailable++;
    }
  }
  const totals = {};
  for (const [key] of USAGE_PERIODS) totals[key] = { active: 0, total: 0 };
  for (const u of [main, ...clones.map((x) => x.usage)].filter(Boolean)) {
    for (const [key] of USAGE_PERIODS) {
      totals[key].active += u[key].active;
      totals[key].total += u[key].total;
    }
  }
  return { main, clones, unavailable, totals };
}

/** One line per period, e.g. "Daily 40% (2 of 5)". */
export function usageLines(usage) {
  if (!usage) return ['—'];
  return USAGE_PERIODS.map(([key, label]) => `${label}: ${pct(usage[key].active, usage[key].total)}% (${usage[key].active} of ${usage[key].total})`);
}
