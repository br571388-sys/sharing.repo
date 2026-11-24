// /dashboard — owner-only operational overview. Never shows tokens, keys or private user data.

import { countUsers } from '../../database/users.js';
import { countGroups } from '../../database/groups.js';
import { broadcastTotals, recentJobs } from '../../database/broadcasts.js';
import { backupCounts, lastBackup, recentBackups } from '../../database/backups.js';
import { getBotSetting } from '../../database/settings.js';
import { btn, markup } from '../../keyboards/inlineKeyboard.js';
import { esc, field, percent, SEP } from '../../utils/formatter.js';
import { formatNumber, formatBytes } from '../../utils/helpers.js';
import { formatDateTimeIST } from '../../services/timezone.js';
import { isBotOwner } from '../../core/permissions.js';
import { reply, safeEdit } from '../../handlers/helpers.js';
import { isMessageNotModified } from '../../services/telegram.js';
import { boxHtml } from '../../ui/design.js';

const ago = (sec) => {
  if (!sec) return 'never';
  const d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (d < 90) return 'just now';
  if (d < 5400) return `${Math.round(d / 60)} min ago`;
  if (d < 129600) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} d ago`;
};

const keyboard = (active) => markup([
  [btn(active === 'main' ? '• 📊 Overview •' : '📊 Overview', 'dash:main'), btn(active === 'bc' ? '• 📢 Broadcasts •' : '📢 Broadcasts', 'dash:bc'), btn(active === 'bk' ? '• 💾 Backups •' : '💾 Backups', 'dash:bk')],
  [btn('🔄 Refresh', `dash:${active}`)],
]);

async function dbStatus(ctx) {
  const t = Date.now();
  try {
    await ctx.db.ping();
    return `Connected (${Date.now() - t} ms)`;
  } catch {
    return 'Unavailable';
  }
}

export async function renderMain(ctx) {
  const [users, groups, bc, auto, anyBackup, dbs, lastUpdate, lastError, started] = await Promise.all([
    countUsers(ctx.db), countGroups(ctx.db), broadcastTotals(ctx.db),
    getBotSetting(ctx.db, 'last_auto_backup_at'), lastBackup(ctx.db),
    dbStatus(ctx), getBotSetting(ctx.db, 'last_update_at'), getBotSetting(ctx.db, 'last_error'), getBotSetting(ctx.db, 'bot_started_at'),
  ]);
  const autoStatus = await getBotSetting(ctx.db, 'last_auto_backup_status', 'none yet');
  const total = bc.ok + bc.failed;
  return [
    '📊 <b>Bot Dashboard</b>', '',
    field('👤', 'Total Users', `${formatNumber(users.total)} (${formatNumber(users.active)} active)`),
    field('👥', 'Total Groups', `${formatNumber(groups.total)} (${formatNumber(groups.active)} active)`),
    field('📢', 'Total Broadcasts', `${formatNumber(bc.jobs)}${bc.active ? ` (${bc.active} running)` : ''}`),
    field('✅', 'Delivered', formatNumber(bc.ok)),
    field('❌', 'Failed', `${formatNumber(bc.failed)}${total ? ` (${percent(bc.ok, total)} success)` : ''}`),
    '', SEP, '',
    field('💾', 'Last Auto Backup', auto ? `${ago(Number(auto))} — ${autoStatus}` : 'never'),
    field('🗂', 'Last Backup (any)', anyBackup ? `${anyBackup.status === 'success' ? '✅' : '❌'} ${anyBackup.backup_type} • ${ago(anyBackup.created_at)}` : 'none'),
    field('🗄', 'Database', dbs),
    field('☁️', 'Backup Storage', ctx.config.bindings.r2 ? 'R2 connected' : 'Not configured (sent via Telegram)'),
    field('📬', 'Broadcast Queue', ctx.config.bindings.queue ? 'Configured' : 'Not configured'),
    field('⚡', 'Cache', ctx.cache.backend === 'kv' ? 'Cloudflare KV' : 'Database'),
    '', SEP, '',
    field('🕒', 'Last Update', lastUpdate ? ago(Number(lastUpdate)) : 'none yet'),
    field('🚀', 'Initialised', started ? formatDateTimeIST(Number(started)) : 'unknown'),
    lastError ? field('⚠️', 'Last Error', lastError) : null,
    '', `🔖 <b>Version:</b> ${esc(ctx.config.version)}`,
  ].filter((l) => l !== null).join('\n');
}

async function renderBroadcasts(ctx) {
  const jobs = await recentJobs(ctx.db, 8);
  if (!jobs.length) return `${boxHtml("📢", "Recent Broadcasts")}\n\nNo broadcasts yet.`;
  const rows = jobs.map((j) => `#${j.id} • ${esc(j.target_type)} • ${esc(j.status)} • ✅ ${formatNumber(j.successful_count)} / ❌ ${formatNumber(j.failed_count)} of ${formatNumber(j.total_recipients)} • ${esc(ago(j.created_at))}`);
  return `${boxHtml("📢", "Recent Broadcasts")}\n\n${rows.join('\n')}\n\nUse <code>/broadcaststatus &lt;id&gt;</code> for details.`;
}

async function renderBackups(ctx) {
  const [rows, counts] = await Promise.all([recentBackups(ctx.db, 8), backupCounts(ctx.db)]);
  if (!rows.length) return `${boxHtml("💾", "Recent Backups")}\n\nNo backups yet. Use /backup to create one.`;
  const list = rows.map((b) => `${b.status === 'success' ? '✅' : '❌'} #${b.id} • ${esc(b.backup_type)}/${esc(b.scope)} • ${b.size_bytes ? esc(formatBytes(b.size_bytes)) : '—'} • ${esc(ago(b.created_at))}${b.error_message ? `\n   ↳ ${esc(b.error_message.slice(0, 80))}` : ''}`);
  return `${boxHtml("💾", "Recent Backups")}\n\n${list.join('\n')}\n\n📦 ${counts.ok} successful • ${counts.failed} failed`;
}

export async function dashboardCommand(ctx, msg) {
  if (msg.chat.type !== 'private') return reply(ctx, msg, `${boxHtml("🔒", "Private Only")}\n\nOpen the dashboard in a private chat with the bot.`);
  return reply(ctx, msg, await renderMain(ctx), { reply_markup: keyboard('main') });
}

/** Callback: dash:<main|bc|bk> */
export async function dashboardCallback(ctx, cq, parts) {
  if (!isBotOwner(ctx.config, cq.from?.id)) return ctx.tg.answerCallbackQuery(cq.id, '🔒 Owner only.', true);
  const page = ['main', 'bc', 'bk'].includes(parts[1]) ? parts[1] : 'main';
  const text = page === 'bc' ? await renderBroadcasts(ctx) : page === 'bk' ? await renderBackups(ctx) : await renderMain(ctx);
  await ctx.tg.answerCallbackQuery(cq.id, page === parts[1] ? 'Updated' : undefined);
  try {
    await ctx.tg.editMessageText(cq.message.chat.id, cq.message.message_id, text, { reply_markup: keyboard(page) });
  } catch (e) {
    if (!isMessageNotModified(e)) throw e;
  }
  return undefined;
}

export { safeEdit };
