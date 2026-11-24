// Automatic backups, driven by the Cron Trigger (checked every minute; the real interval is BACKUP_INTERVAL).
//
//  * Each backup is a NEW object (timestamped key): the previous valid backup is never overwritten.
//  * The backup is validated before it counts as successful; with R2 it is also read back (size check).
//  * Old backups are pruned only after a new one succeeded, keeping BACKUP_RETENTION of them.
//  * Without R2 the file is sent to the owner's Telegram chat instead (Telegram keeps it, separate from the DB).
//  * Failures are logged, retried later (not every minute) and reported to the owner.

import { createValidatedBackup } from './manualBackup.js';
import { fileNameFor } from './snapshot.js';
import { getBotSetting, setBotSetting } from '../../database/settings.js';
import { logBackup } from '../../database/backups.js';
import { formatBytes, nowSec } from '../../utils/helpers.js';
import { messages } from '../../utils/formatter.js';
import { logger } from '../../utils/logger.js';
import { backupCaption } from './manualBackup.js';

const LOCK_SEC = 600;
const MAX_RETRY_DELAY_SEC = 3600;

/** Cross-invocation lock so two overlapping cron runs cannot both back up. */
async function acquireLock(db) {
  const now = nowSec();
  const res = await db.execute(
    `INSERT INTO bot_settings (setting_key, setting_value, updated_at) VALUES ('auto_backup_lock', ?, ?)
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at
     WHERE CAST(bot_settings.setting_value AS INTEGER) < ?`,
    [String(now + LOCK_SEC), now, now],
  );
  return res.rowsAffected > 0;
}

async function releaseLock(db) {
  await setBotSetting(db, 'auto_backup_lock', '0');
}

export function isBackupDue({ intervalMs, lastSuccessSec, lastAttemptSec, now = nowSec() }) {
  if (!intervalMs) return false;
  const interval = Math.floor(intervalMs / 1000);
  if (lastSuccessSec && now - lastSuccessSec < interval) return false;
  // After a failure, wait before retrying (but never longer than an hour).
  const retryDelay = Math.min(interval, MAX_RETRY_DELAY_SEC);
  if (lastAttemptSec && lastAttemptSec > (lastSuccessSec || 0) && now - lastAttemptSec < retryDelay) return false;
  return true;
}

/**
 * Runs the backup if one is due. Returns { ran, ok, reason?, key? }.
 * `force` skips the schedule (used by tests / owner tools).
 */
export async function runAutomaticBackup(ctx, { force = false } = {}) {
  const { backup: cfg } = ctx.config;
  if (!cfg.enabled) return { ran: false, reason: 'disabled' };
  if (!cfg.intervalMs) return { ran: false, reason: 'invalid interval' };

  const lastSuccess = Number(await getBotSetting(ctx.db, 'last_auto_backup_at', 0)) || 0;
  const lastAttempt = Number(await getBotSetting(ctx.db, 'last_auto_backup_attempt_at', 0)) || 0;
  if (!force && !isBackupDue({ intervalMs: cfg.intervalMs, lastSuccessSec: lastSuccess, lastAttemptSec: lastAttempt })) return { ran: false, reason: 'not due' };
  if (!(await acquireLock(ctx.db))) return { ran: false, reason: 'locked' };

  await setBotSetting(ctx.db, 'last_auto_backup_attempt_at', nowSec());
  try {
    const made = await createValidatedBackup(ctx, 'global');
    const name = fileNameFor(made.backup, new Date(), ctx.config.botSlug);
    let location;

    if (ctx.storage.configured) {
      const key = `auto/${name}`;
      await ctx.storage.put(key, made.bytes, { metadata: { scope: 'global', created: String(made.backup.created_at_unix), schema: String(made.backup.schema_version) } });
      const head = await ctx.storage.head(key);
      if (!head || head.size !== made.bytes.length) throw new Error('R2 verification failed (object missing or wrong size)');
      location = `r2:${key}`;
      // Prune only now that the new backup is stored and verified.
      await ctx.storage.prune('auto/', Math.max(1, cfg.retention));
    } else {
      await ctx.tg.sendDocument(ctx.config.ownerId, made.bytes, name, {
        caption: `${backupCaption(made.backup, made.bytes.length, { note: '🤖 Automatic backup' })}\n\n💡 Configure an R2 bucket to keep backups in Cloudflare instead (see README).`,
      });
      location = 'telegram:owner';
    }

    await logBackup(ctx.db, { type: 'automatic', scope: 'global', ownerId: ctx.config.ownerId, location, sizeBytes: made.bytes.length });
    await setBotSetting(ctx.db, 'last_auto_backup_at', nowSec());
    await setBotSetting(ctx.db, 'last_auto_backup_status', `ok (${formatBytes(made.bytes.length)})`);
    return { ran: true, ok: true, location };
  } catch (e) {
    logger.error(`automatic backup failed: ${e?.message}`);
    await logBackup(ctx.db, { type: 'automatic', scope: 'global', ownerId: ctx.config.ownerId, status: 'failed', error: e?.message }).catch(() => {});
    await setBotSetting(ctx.db, 'last_auto_backup_status', `failed: ${String(e?.message).slice(0, 80)}`).catch(() => {});
    try {
      await ctx.tg.sendMessage(ctx.config.ownerId, messages.error('Automatic Backup Failed', `The scheduled backup could not be completed: ${String(e?.message).slice(0, 200)}\n\nThe previous valid backup is untouched. I will retry automatically.`));
    } catch { /* owner may not have started the bot */ }
    return { ran: true, ok: false, error: e?.message };
  } finally {
    await releaseLock(ctx.db).catch(() => {});
  }
}

/** Lists automatic backups stored in R2 (newest first). */
export async function listStoredBackups(ctx, limit = 10) {
  if (!ctx.storage.configured) return [];
  return (await ctx.storage.list('auto/')).slice(0, limit);
}
