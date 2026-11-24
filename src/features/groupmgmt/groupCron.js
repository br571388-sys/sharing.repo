// Scheduled group jobs (run by the 1-minute cron trigger). The Worker never stays alive between runs, so everything
import { flushActivityLog, logModerationLogged } from '../../core/activityLog.js';
// that must happen "later" is stored in Turso and picked up here.

import { dueDeletes, dueRestrictions, markRestrictionExpired, purgeFloodRecords, purgeGroupHistory, removeScheduledDeletes } from '../../database/groupMod.js';
import { nowSec } from '../../utils/helpers.js';
import { expireVerifications } from './captcha.js';
import { runGbanJob } from '../roles/gban.js';
import { logger } from '../../utils/logger.js';

/** Temporary bans / mutes: Telegram lifts them itself at until_date; here we confirm, mark them expired and log it. */
export async function expireRestrictions(ctx, now = nowSec()) {
  let n = 0;
  for (const r of await dueRestrictions(ctx.db, now)) {
    if (r.kind === 'ban') await ctx.tg.unbanChatMember(r.telegram_chat_id, r.user_id, true).catch(() => {}); // harmless if Telegram already did it
    await markRestrictionExpired(ctx.db, r.id);
    await logModerationLogged(ctx, { id: r.group_id }, { action: `${r.kind}_expired`, target: r.user_id, reason: 'temporary restriction ended' }).catch(() => {});
    n++;
  }
  return n;
}

export async function runScheduledDeletes(ctx, now = nowSec()) {
  const due = await dueDeletes(ctx.db, now);
  for (const d of due) await ctx.tg.deleteMessage(d.chat_id, d.message_id).catch(() => {});
  await removeScheduledDeletes(ctx.db, due.map((d) => d.id));
  return due.length;
}

export async function runGroupCron(ctx, now = new Date()) {
  try { return await runGroupCronInner(ctx, now); } finally { await flushActivityLog(ctx); }
}

async function runGroupCronInner(ctx, now) {
  const out = {};
  const sec = Math.floor(now.getTime() / 1000);
  const job = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = { error: e?.message }; logger.error(`group cron ${name} failed: ${e?.message}`); } };
  await job('restrictions', () => expireRestrictions(ctx, sec));
  await job('verifications', () => expireVerifications(ctx, sec));
  await job('deletes', () => runScheduledDeletes(ctx, sec));
  await job('gban', () => runGbanJob(ctx));
  if (now.getUTCMinutes() === 0) {
    await job('housekeeping', async () => ({ flood: await purgeFloodRecords(ctx.db), history: await purgeGroupHistory(ctx.db) }));
  }
  return out;
}
