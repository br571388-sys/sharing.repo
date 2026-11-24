// Progress rendering and throttled progress-message updates for broadcast jobs.

import { SEP, esc, field, percent } from '../../utils/formatter.js';
import { btn, markup } from '../../keyboards/inlineKeyboard.js';
import { isMessageNotModified } from '../../services/telegram.js';
import { formatNumber as formatNumberSafe, nowSec } from '../../utils/helpers.js';
import { touchProgress } from '../../database/broadcasts.js';
import { logger } from '../../utils/logger.js';

const TARGET_LABEL = { users: 'All Users', groups: 'All Groups', all: 'Users & Groups' };
const STATUS_LABEL = {
  preparing: '🛠 Preparing', queued: '⏳ Queued', running: '🚀 In Progress', completed: '✅ Completed',
  cancelled: '🛑 Cancelled', failed: '❌ Failed',
};

export function progressBar(done, total, width = 12) {
  const ratio = total ? Math.min(done / total, 1) : 0;
  const filled = Math.round(ratio * width);
  return `${'▓'.repeat(filled)}${'░'.repeat(width - filled)} ${Math.round(ratio * 100)}%`;
}

export function renderProgress(job, stats) {
  const finished = ['completed', 'cancelled', 'failed'].includes(job.status);
  const done = stats.sent + stats.failed;
  const remaining = stats.pending + stats.sending;
  const head = finished
    ? (job.status === 'completed' ? '📢 <b>Broadcast Completed</b>' : `📢 <b>Broadcast ${job.status === 'cancelled' ? 'Cancelled' : 'Failed'}</b>`)
    : '📢 <b>Broadcast In Progress</b>';
  const lines = [
    head, '',
    field('🆔', 'Job', `#${job.id}`),
    field('🎯', 'Target', TARGET_LABEL[job.target_type] || job.target_type),
    field('📡', 'Status', STATUS_LABEL[job.status] || job.status),
    '',
    field('👥', 'Total Recipients', formatNumberSafe(job.total_recipients)),
    field('✅', 'Successful', formatNumberSafe(stats.sent)),
    field('❌', 'Failed', formatNumberSafe(stats.failed)),
  ];
  if (!finished) lines.push(field('⏳', 'Remaining', formatNumberSafe(remaining)));
  lines.push(field('📊', 'Success Rate', percent(stats.sent, Math.max(done, finished ? job.total_recipients : done))));
  if (!finished) lines.push('', `<code>${progressBar(done, job.total_recipients)}</code>`);
  if (stats.blocked) lines.push('', `🚫 ${esc(formatNumberSafe(stats.blocked))} chats blocked the bot or are unavailable.`);
  if (finished) lines.push('', SEP);
  return lines.join('\n');
}

export function progressKeyboard(job) {
  if (['completed', 'cancelled', 'failed'].includes(job.status)) return markup([[btn('🔄 Refresh', `bc:r:${job.id}`)]]);
  return markup([[btn('🔄 Refresh', `bc:r:${job.id}`), btn('🛑 Cancel', `bc:x:${job.id}`)]]);
}

/** Edits the owner's progress message. Throttled to once / 4s unless `force`. Never throws. */
export async function updateProgress(ctx, job, stats, { force = false } = {}) {
  if (!job.progress_chat_id || !job.progress_message_id) return;
  if (!force && nowSec() - (job.progress_updated_at || 0) < 4) return;
  try {
    await ctx.tg.editMessageText(job.progress_chat_id, job.progress_message_id, renderProgress(job, stats), { reply_markup: progressKeyboard(job) });
    await touchProgress(ctx.db, job.id);
  } catch (e) {
    if (!isMessageNotModified(e)) logger.warn('progress update failed', { job: job.id, error: e?.message });
  }
}
