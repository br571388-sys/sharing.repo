// Global bans are kept in the main database and mirrored into every clone's own database,
// so a clone enforces the same bans in its groups. Failures are logged per clone and never block the main ban.
import { listClones, getCloneSecrets } from '../../database/clones.js';
import { activeGroupChatIds, queueBanResults, queueUnbanResults } from '../../database/roles.js';
import { recordError } from '../../core/errorHandler.js';
import { openCloneDb } from './clonebot.js';

const UPSERT = `INSERT INTO global_bans (user_id, moderator_id, reason, status, created_at, lifted_by, lifted_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET status = excluded.status, reason = excluded.reason, lifted_by = excluded.lifted_by, lifted_at = excluded.lifted_at`;

/** Writes one ban change into every clone database that still exists. */
export async function syncGbanToClones(ctx, { userId, status, moderatorId, reason = null, createdAt, liftedBy = null, liftedAt = null }) {
  let synced = 0;
  let failed = 0;
  for (const c of await listClones(ctx.db, null)) {
    if (c.status === 'db_deleted') continue;
    try {
      const row = await getCloneSecrets(ctx.db, c.id);
      const cloneDb = await openCloneDb(ctx, row);
      await cloneDb.execute(UPSERT, [Number(userId), Number(moderatorId), reason, status, Number(createdAt), liftedBy, liftedAt]);
      // queue the ban/unban for every group THIS clone is in; the clone's ban cron applies it
      if (status === 'active') await queueBanResults(cloneDb, userId, await activeGroupChatIds(cloneDb));
      else await queueUnbanResults(cloneDb, userId);
      synced++;
    } catch (e) {
      failed++;
      await recordError(ctx, `global ban sync (clone ${c.id})`, e);
    }
  }
  return { synced, failed };
}

/** When a new clone database is set up, it receives every ban that is active in the main database. */
export async function seedCloneBans(mainDb, cloneDb) {
  const bans = await mainDb.all('SELECT user_id, moderator_id, reason, status, created_at, lifted_by, lifted_at FROM global_bans');
  for (const b of bans) {
    await cloneDb.execute(UPSERT, [b.user_id, b.moderator_id, b.reason, b.status, b.created_at, b.lifted_by, b.lifted_at]);
  }
  return bans.length;
}
