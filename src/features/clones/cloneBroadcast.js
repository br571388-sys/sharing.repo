// Broadcast inside clone bots. A clone only gets a broadcast when the Main Owner approved it (broadcast_approved).
// The main /broadcast can include approved clones: each one gets its own job in its own database, sent with its own
// token. The cron drives those jobs (the main queue consumer only knows the main bot's token).
// Clone bots send text messages only: media and "copy" payloads use the main bot's file ids and chats.
import { listClones, getCloneSecrets } from '../../database/clones.js';
import { createJob, setJobStatus } from '../../database/broadcasts.js';
import { processChunk } from '../broadcast/queue.js';
import { recordError } from '../../core/errorHandler.js';
import { isOn } from '../roles/controls.js';
import { buildCloneContext, cloneSecrets } from './cloneRuntime.js';
import { openCloneDb } from './clonebot.js';

export const CLONE_PAYLOAD_KINDS = new Set(['text']);

/** Approved and running clones (the only ones that can receive a broadcast). */
export async function approvedCloneList(db) {
  return (await listClones(db, null)).filter((c) => c.broadcast_approved && c.status === 'running');
}

/** Creates one job per approved clone. Returns how many were created. */
export async function createCloneJobs(ctx, { createdBy, targetType, payload, cloneIds }) {
  let created = 0;
  const chosen = new Set((cloneIds || []).map(Number));
  for (const c of (await approvedCloneList(ctx.db)).filter((x) => chosen.has(Number(x.id)))) {
    try {
      const row = await getCloneSecrets(ctx.db, c.id);
      const cloneDb = await openCloneDb(ctx, row);
      await createJob(cloneDb, { createdBy: c.owner_user_id, targetType, payload, progressChatId: null });
      created++;
    } catch (e) {
      await recordError(ctx, `clone broadcast (${c.id})`, e);
    }
  }
  return created;
}

/** Cron: sends queued clone broadcast jobs, a few chunks per run. */
export async function runCloneBroadcastJobs(ctx) {
  if (await isOn(ctx.db, 'clones_paused')) return { skipped: 'paused' };
  const out = {};
  for (const c of (await listClones(ctx.db, null)).filter((x) => x.status === 'running')) {
    try {
      const row = await getCloneSecrets(ctx.db, c.id);
      const cloneDb = await openCloneDb(ctx, row);
      const jobs = await cloneDb.all("SELECT id FROM broadcast_jobs WHERE status IN ('queued', 'running') ORDER BY id LIMIT 3");
      if (!jobs.length) continue;
      if (!c.broadcast_approved) {
        for (const j of jobs) await setJobStatus(cloneDb, j.id, 'cancelled', { error: 'Permission removed by the Main Owner' });
        out[c.id] = 'cancelled';
        continue;
      }
      const cctx = buildCloneContext(ctx, c, await cloneSecrets(ctx.config, row), cloneDb);
      for (const j of jobs) {
        for (let i = 0; i < 3; i++) {
          const { done } = await processChunk(cctx, j.id);
          if (done) break;
        }
      }
      out[c.id] = jobs.map((j) => j.id);
    } catch (e) {
      out[c.id] = { error: String(e?.message || e).slice(0, 120) };
      await recordError(ctx, `clone broadcast job (${c.id})`, e);
    }
  }
  return out;
}
