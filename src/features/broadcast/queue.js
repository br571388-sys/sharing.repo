// Broadcast processing on Cloudflare Queues.
//
// Design:
//  * The recipient list lives in broadcast_logs (one row per chat). The queue message only carries { jobId }.
//  * Each queue message processes ONE chunk: claim rows (pending -> sending), send, record results, then either
//    re-enqueue itself for the next chunk or finalise the job. The worker never runs a whole broadcast at once.
//  * max_concurrency = 1 (wrangler.toml) so chunks of a job never overlap; claiming is also atomic in SQL.
//  * Delivery is at-most-once per recipient: a row is only ever claimed once. Rows left in 'sending' by a crash
//    are settled as 'unknown' (failed) instead of being re-sent, so nobody receives a duplicate.
//  * The cron trigger re-enqueues jobs that stopped making progress, so a job is never lost.

import { sendPayload } from './sender.js';
import { updateProgress } from './progress.js';
import {
  claimBatch, getJob, jobStats, listStaleJobs, failStalePreparing, markResults, refreshCounters, setJobStatus, settleStaleSending, touchJob,
} from '../../database/broadcasts.js';
import { setUserBlocked } from '../../database/users.js';
import { setGroupActive } from '../../database/groups.js';
import { isPermanentDeliveryError } from '../../services/telegram.js';
import { TelegramError } from '../../utils/errors.js';
import { mapLimit, sleep } from '../../utils/helpers.js';
import { logger } from '../../utils/logger.js';
import { renderProgress } from './progress.js';

const MAX_SEND_RATE = 25; // messages per second, below Telegram's ~30/s global limit
const MAX_ATTEMPTS = 3;

export async function enqueueJob(env, jobId, delaySeconds = 0) {
  if (!env.BROADCAST_QUEUE) throw new Error('BROADCAST_QUEUE binding is not configured');
  await env.BROADCAST_QUEUE.send({ jobId: Number(jobId) }, delaySeconds > 0 ? { delaySeconds: Math.min(Math.ceil(delaySeconds), 86400) } : undefined);
}

/** Classifies a send failure into the row status to store. */
export function classifyFailure(err, attempts) {
  if (err instanceof TelegramError && err.status === 429 && err.retryAfter) {
    return attempts >= 5 ? { status: 'failed', retryAfter: 0 } : { status: 'pending', retryAfter: err.retryAfter };
  }
  if (isPermanentDeliveryError(err)) return { status: 'blocked', retryAfter: 0 };
  const transient = err instanceof TelegramError && (err.status === 0 || err.status >= 500);
  if (transient && attempts < MAX_ATTEMPTS) return { status: 'pending', retryAfter: 2 };
  return { status: 'failed', retryAfter: 0 };
}

/**
 * Processes one chunk of a job. Returns { requeueIn: seconds | null, done: boolean }.
 * `sender` is injectable for tests.
 */
export async function processChunk(ctx, jobId, { sender = sendPayload, sleepFn = sleep } = {}) {
  const job = await getJob(ctx.db, jobId);
  if (!job) return { requeueIn: null, done: true };
  if (!['queued', 'running'].includes(job.status)) return { requeueIn: null, done: true };
  if (!job.payload) {
    await setJobStatus(ctx.db, job.id, 'failed', { error: 'Corrupted message payload' });
    return { requeueIn: null, done: true };
  }
  if (job.status === 'queued') await setJobStatus(ctx.db, job.id, 'running');
  job.status = 'running';

  const { chunkSize, concurrency } = ctx.config.broadcast;
  const claimed = await claimBatch(ctx.db, job.id, chunkSize);

  let retryAfter = 0;
  if (claimed.length) {
    const started = Date.now();
    const results = await mapLimit(claimed, concurrency, async (row) => {
      try {
        const sent = await sender(ctx, row.chat_id, job.payload);
        // "Pin & Send": pin the delivered message. Pinning can fail (no rights, private chat limits); that never
        // changes the delivery result, the message was still sent.
        if (job.payload?.pin && sent?.message_id) {
          await ctx.tg.call('pinChatMessage', { chat_id: row.chat_id, message_id: sent.message_id, disable_notification: true }, { autoRetry: false }).catch(() => {});
        }
        return { id: row.id, row, status: 'sent' };
      } catch (err) {
        const c = classifyFailure(err, row.attempts);
        if (c.retryAfter) retryAfter = Math.max(retryAfter, c.retryAfter);
        return { id: row.id, row, status: c.status, error: err?.message || String(err) };
      }
    });
    await markResults(ctx.db, results);

    // Chats that can never receive messages are flagged so future jobs skip them.
    for (const r of results.filter((x) => x.status === 'blocked')) {
      if (r.row.chat_type === 'user') await setUserBlocked(ctx.db, r.row.chat_id, true);
      else await setGroupActive(ctx.db, r.row.chat_id, false);
    }

    // Pace the chunk to stay under Telegram's global rate limit.
    const minMs = Math.ceil((claimed.length / MAX_SEND_RATE) * 1000);
    const elapsed = Date.now() - started;
    if (elapsed < minMs) await sleepFn(minMs - elapsed);
  }

  await settleStaleSending(ctx.db, job.id);
  let stats = await refreshCounters(ctx.db, job.id);

  // Honour a cancellation made while this chunk was running.
  const fresh = await getJob(ctx.db, job.id);
  if (fresh.status === 'cancelled') {
    await updateProgress(ctx, fresh, stats, { force: true });
    return { requeueIn: null, done: true };
  }

  if (stats.pending > 0) {
    await touchJob(ctx.db, job.id);
    await updateProgress(ctx, { ...fresh, status: 'running' }, stats);
    return { requeueIn: retryAfter > 0 ? retryAfter + 1 : 0, done: false };
  }
  if (stats.sending > 0) {
    // Another consumer holds rows; look again shortly (stale rows are settled after 5 minutes).
    await touchJob(ctx.db, job.id);
    return { requeueIn: 30, done: false };
  }

  await setJobStatus(ctx.db, job.id, 'completed');
  stats = await refreshCounters(ctx.db, job.id);
  const done = await getJob(ctx.db, job.id);
  await updateProgress(ctx, done, stats, { force: true });
  await notifyCompletion(ctx, done, stats);
  return { requeueIn: null, done: true };
}

async function notifyCompletion(ctx, job, stats) {
  // The progress message already shows the result; send a fresh message so the owner gets a notification.
  if (!job.progress_chat_id) return;
  try {
    await ctx.tg.sendMessage(job.progress_chat_id, renderProgress(job, stats), { disable_notification: false });
  } catch (e) {
    logger.warn('completion notice failed', { error: e?.message });
  }
}

/** Queue consumer entry point. */
export async function handleQueueBatch(batch, ctx) {
  for (const message of batch.messages) {
    const jobId = Number(message.body?.jobId);
    if (!Number.isInteger(jobId)) { message.ack(); continue; }
    try {
      const { requeueIn, done } = await processChunk(ctx, jobId);
      if (!done) await enqueueJob(ctx.env, jobId, requeueIn || 0);
      message.ack();
    } catch (err) {
      logger.error(`broadcast job ${jobId} chunk failed: ${err?.message}`);
      message.retry({ delaySeconds: 30 });
    }
  }
}

/** Cron: restart jobs that stalled (lost queue message / crashed consumer). Returns the job ids re-enqueued. */
export async function sweepStaleJobs(ctx) {
  await failStalePreparing(ctx.db);
  if (!ctx.config.bindings.queue) return [];
  const stale = await listStaleJobs(ctx.db, 180);
  for (const job of stale) await enqueueJob(ctx.env, job.id);
  return stale.map((j) => j.id);
}
