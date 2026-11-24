// Cron job: checks each running clone's webhook with getWebhookInfo. Rate-limited per clone (every 10 minutes),
// skipped while clones are paused, and the owner is notified once after 3 failures in a row.
import { listClones, updateClone, getCloneSecrets, getClone } from '../../database/clones.js';
import { isOn } from '../roles/controls.js';
import { decryptSecret } from '../../core/cloneCrypto.js';
import { cloneWebhookUrl, verifyCloneWebhook } from './webhook.js';
import { notifyCloneOwner } from './clonebot.js';
import { nowSec } from '../../utils/helpers.js';
import { recordError } from '../../core/errorHandler.js';
import { buildCloneContext, cloneSecrets } from './cloneRuntime.js';
import { runGbanJob } from '../roles/gban.js';
import { openCloneDb } from './clonebot.js';

const CHECK_EVERY_SEC = 600;
const FAILS_BEFORE_ALERT = 3;

export async function runCloneHealth(ctx, now = new Date()) {
  if (await isOn(ctx.db, 'clones_paused')) return { skipped: 'paused' };
  const clones = (await listClones(ctx.db, null)).filter((c) => c.status === 'running' || c.status === 'webhook_failed');
  const at = Math.floor(now.getTime() / 1000);
  let checked = 0;
  for (const c of clones) {
    if (c.last_check_at && at - Number(c.last_check_at) < CHECK_EVERY_SEC) continue;
    const row = await getCloneSecrets(ctx.db, c.id);
    if (!row?.token_enc) continue;
    checked++;
    const token = await decryptSecret(ctx.config.cloneKey, row.token_enc);
    const expected = await cloneWebhookUrl(ctx.db, c.id);
    const info = await verifyCloneWebhook(token, expected);
    if (info.ok) {
      await updateClone(ctx.db, c.id, { last_check_at: at, webhook_fail_count: 0, last_error: null, status: 'running' });
      continue;
    }
    const fails = Number(c.webhook_fail_count || 0) + 1;
    await updateClone(ctx.db, c.id, { last_check_at: at, webhook_fail_count: fails, last_error: info.error });
    if (fails === FAILS_BEFORE_ALERT && c.status !== 'webhook_failed') {
      await updateClone(ctx.db, c.id, { status: 'webhook_failed' });
      await notifyCloneOwner(ctx, await getClone(ctx.db, c.id), 'webhook_failed', '⚠️', 'Webhook Failed', [
        `🤖 ${c.bot_name}`, `❌ ${info.error}`, '👉 Use /myclone → Restart, or the webhook link, to set it again.',
      ]);
    }
  }
  return { checked, at: nowSec() };
}

/** Cron: applies queued global bans/unbans inside each running clone (its own groups, with its own bot token). */
export async function runCloneGbanJobs(ctx) {
  if (await isOn(ctx.db, 'clones_paused')) return { skipped: 'paused' };
  const out = {};
  for (const c of (await listClones(ctx.db, null)).filter((x) => x.status === 'running')) {
    try {
      const row = await getCloneSecrets(ctx.db, c.id);
      const secrets = await cloneSecrets(ctx.config, row);
      const cloneDb = await openCloneDb(ctx, row);
      const cctx = buildCloneContext(ctx, c, secrets, cloneDb);
      out[c.id] = await runGbanJob(cctx);
    } catch (e) {
      out[c.id] = { error: String(e?.message || e).slice(0, 120) };
      await recordError(ctx, `clone ban job (${c.id})`, e);
    }
  }
  return out;
}
