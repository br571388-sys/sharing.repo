// Main Owner's "Clones" panel (opened from Bot Controls): dashboard, list of all clones, and per-clone actions.
// Only the Main Owner can use it. Every action changes the database first, then notifies the clone owner.
import { btn, markup, backCloseRow, pagerRow } from '../../keyboards/inlineKeyboard.js';
import { blockquote, box, row } from '../../ui/design.js';
import { esc } from '../../utils/formatter.js';
import { isBotOwner } from '../../core/permissions.js';
import { decryptSecret } from '../../core/cloneCrypto.js';
import { cloneLimit, getClone, getCloneSecrets, listClones, updateClone } from '../../database/clones.js';
import { setBotSetting } from '../../database/settings.js';
import { listSudoUsers } from '../../database/roles.js';
import { logAudit } from '../../database/roles.js';
import { recordError } from '../../core/errorHandler.js';
import { deleteCloneWebhook, setAndVerifyCloneWebhook } from './webhook.js';
import { notifyCloneOwner, openCloneDb } from './clonebot.js';
import { toggleControl, isOn } from '../roles/controls.js';
import { overallUsage, usageOf, usageLines, pct, USAGE_PERIODS } from './usage.js';

const PAGE = 5;
const LIMIT_MIN = 1;
const LIMIT_MAX = 20;

const STATUS_NAME = { running: '🟢 Running', stopped: '🔴 Stopped', webhook_failed: '🟠 Webhook Not Set', db_deleted: '⚪ Database deleted' };

async function countOf(db, table) {
  try { return String((await db.value(`SELECT COUNT(*) FROM ${table}`, [], 0)) ?? 0); } catch { return '—'; }
}

async function dashboard(ctx) {
  const all = await listClones(ctx.db, null);
  const count = (s) => all.filter((c) => c.status === s).length;
  const limit = await cloneLimit(ctx.db);
  const cloning = await isOn(ctx.db, 'cloning_enabled');
  const paused = await isOn(ctx.db, 'clones_paused');
  const lines = [
    row('🧬', 'Total clones', String(all.length)),
    row('🟢', 'Running', String(count('running'))),
    row('🔴', 'Stopped', String(count('stopped'))),
    row('🟠', 'Webhook Not Set', String(count('webhook_failed'))),
    row('⚪', 'Database deleted', String(count('db_deleted'))),
    row('📣', 'Broadcast enabled', String(all.filter((c) => c.broadcast_approved).length)),
    row('🔢', 'Limit per user', String(limit)),
    row('🧬', 'New clones', cloning ? 'Allowed' : 'Stopped'),
    row('⏸', 'All clones', paused ? 'Paused by the owner' : 'Allowed to run'),
  ].join('\n');
  const rows = [
    [btn('📋 List clones', 'cm:l:0', { style: 'primary' }), btn(paused ? '▶️ Resume all clones' : '⏸ Stop all clones', 'cm:ck', { style: paused ? 'success' : 'danger' })],
    [btn('➖ Limit', `cm:L:${-1}`, { style: 'danger' }), btn('➕ Limit', `cm:L:${1}`, { style: 'success' })],
    backCloseRow('pn:ct'),
  ];
  const u = await overallUsage(ctx);
  const usageText = USAGE_PERIODS.map(([key, label]) => `${label}: ${pct(u.totals[key].active, u.totals[key].total)}% (${u.totals[key].active} of ${u.totals[key].total})`).join('\n');
  const note = u.unavailable ? `\n⚠️ ${u.unavailable} clone database(s) could not be read.` : '';
  return { text: `${box('🧬', 'Clones')}\n\n${blockquote(lines)}\n\n${box('📈', 'Usage: Main + Clones')}\n\n${blockquote(`${usageText}${note}`)}`, keyboard: markup(rows) };
}

async function listScreen(ctx, page) {
  const all = await listClones(ctx.db, null);
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  const p = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const slice = all.slice(p * PAGE, p * PAGE + PAGE);
  const body = slice.length
    ? slice.map((c) => `${esc(c.bot_name)} ${c.bot_username ? `(@${esc(c.bot_username)})` : ''}\n${STATUS_NAME[c.status] || c.status} · owner <code>${Number(c.owner_user_id)}</code>`).join('\n\n')
    : 'No clone bots yet.';
  const rows = slice.map((c) => [btn(`🤖 ${c.bot_name.slice(0, 22)}`, `cm:v:${c.id}`, { style: c.status === 'running' ? 'success' : 'primary' })]);
  const pager = pagerRow(p, pages, (n) => `cm:l:${n}`);
  if (pager.length) rows.push(pager);
  rows.push(backCloseRow('cm:d'));
  return { text: `${box('📋', `Clones (${all.length})`)}\n\n${blockquote(body)}`, keyboard: markup(rows) };
}

async function detailScreen(ctx, id) {
  const clone = await getClone(ctx.db, id);
  if (!clone) return null;
  let users = '—', groups = '—', sudo = '—', sudoIds = [], usage = null;
  try {
    const row0 = await getCloneSecrets(ctx.db, id);
    const cloneDb = await openCloneDb(ctx, row0);
    users = await countOf(cloneDb, 'users');
    groups = await countOf(cloneDb, 'groups');
    usage = await usageOf(cloneDb, undefined, { heal: true });
    const mods = await listSudoUsers(cloneDb);
    sudoIds = mods.slice(0, 10).map((m) => Number(m.user_id));
    sudo = String(mods.length);
  } catch { /* the clone database is unreachable: show dashes */ }
  const text = `${box('🤖', esc(clone.bot_name))}\n\n${blockquote([
    `👤 Username: ${clone.bot_username ? `@${esc(clone.bot_username)}` : '—'}`,
    `🧑 Owner: <code>${Number(clone.owner_user_id)}</code>`,
    `📶 Status: ${STATUS_NAME[clone.status] || clone.status}`,
    `👥 Users: ${users}`,
    `🏘 Groups: ${groups}`,
    `🛡 Sudo users: ${sudo}`,
    ...usageLines(usage).map((l) => `📈 ${l}`),
    ...sudoIds.map((uid) => `   • <code>${uid}</code>`),
    `📣 Broadcast: ${clone.broadcast_approved ? 'Approved' : 'Not approved'}`,
    `⏹ Stopped by: ${clone.stopped_by === 'main' ? 'Main Owner' : clone.stopped_by === 'owner' ? 'Clone owner' : '—'}`,
    clone.last_error ? `❌ Last error: ${esc(clone.last_error)}` : null,
  ].filter(Boolean).join('\n'))}`;
  const rows = [];
  if (clone.status === 'running') rows.push([btn('⏹ Stop', `cm:s:${id}`, { style: 'danger' }), btn('🔁 Restart', `cm:r:${id}`, { style: 'primary' })]);
  else if (clone.status !== 'db_deleted') rows.push([btn('▶️ Resume', `cm:r:${id}`, { style: 'success' })]);
  rows.push([btn(clone.broadcast_approved ? '📣 Broadcast: Approved' : '📣 Approve broadcast', `cm:b:${id}`, { style: clone.broadcast_approved ? 'danger' : 'success' })]);
  rows.push([btn('🗑 Remove clone', `cm:R:${id}`, { style: 'danger' })]);
  rows.push([btn('◀️ Back', 'cm:l:0', { style: 'primary' }), btn('❌ Close', 'x:close', { style: 'danger' })]);
  return { text, keyboard: markup(rows) };
}

async function show(ctx, cq, screen, toast = '') {
  if (screen) await ctx.tg.editMessageText(cq.message.chat.id, cq.message.message_id, screen.text, { reply_markup: screen.keyboard }).catch(() => {});
  return ctx.tg.answerCallbackQuery(cq.id, toast, false);
}

export async function cloneManageCallback(ctx, cq, parts) {
  if (!isBotOwner(ctx.config, cq.from.id)) return ctx.tg.answerCallbackQuery(cq.id, 'Only the Main Owner can use this.', true);
  const action = parts[1];
  const id = Number(parts[2]);
  try {
    switch (action) {
      case 'd': return show(ctx, cq, await dashboard(ctx));
      case 'l': return show(ctx, cq, await listScreen(ctx, parts[2]));
      case 'v': return show(ctx, cq, await detailScreen(ctx, id));
      case 'ck': {
        const toast = await toggleControl(ctx, 'ck', cq.from);
        return show(ctx, cq, await dashboard(ctx), toast);
      }
      case 'L': {
        const delta = Number(parts[2]) === -1 ? -1 : 1;
        const next = Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, (await cloneLimit(ctx.db)) + delta));
        await setBotSetting(ctx.db, 'clone_limit', String(next));
        return show(ctx, cq, await dashboard(ctx), `Limit per user: ${next}`);
      }
      case 's': {
        const row = await getCloneSecrets(ctx.db, id);
        if (!row || row.status === 'removed') return ctx.tg.answerCallbackQuery(cq.id, 'Clone not found.', true);
        await deleteCloneWebhook(await decryptSecret(ctx.config.cloneKey, row.token_enc));
        await updateClone(ctx.db, id, { status: 'stopped', stopped_by: 'main' });
        await logAudit(ctx.db, { actor: cq.from.id, action: 'clone_stop', target: id });
        await notifyCloneOwner(ctx, await getClone(ctx.db, id), 'stopped', '⏹', 'Clone Bot Stopped', [`🤖 ${esc(row.bot_name)}`, '⏹ Stopped by: Main Owner', '🚫 You cannot resume it yourself. Contact support.'], markup([[btn('💬 Message Owner', `ur:${ctx.config.ownerId}`, { style: 'primary' })]]));
        return show(ctx, cq, await detailScreen(ctx, id), 'Stopped.');
      }
      case 'r': {
        const row = await getCloneSecrets(ctx.db, id);
        if (!row || row.status === 'removed') return ctx.tg.answerCallbackQuery(cq.id, 'Clone not found.', true);
        const token = await decryptSecret(ctx.config.cloneKey, row.token_enc);
        const hook = await setAndVerifyCloneWebhook(ctx, id, token, await decryptSecret(ctx.config.cloneKey, row.webhook_secret_enc));
        if (!hook.ok) {
          await updateClone(ctx.db, id, { status: 'webhook_failed', last_error: hook.error });
          return show(ctx, cq, await detailScreen(ctx, id), 'Webhook not set. See the error.');
        }
        await updateClone(ctx.db, id, { status: 'running', stopped_by: 'none', webhook_fail_count: 0, last_error: null });
        await logAudit(ctx.db, { actor: cq.from.id, action: 'clone_resume', target: id });
        const wasStopped = row.status === 'stopped';
        await notifyCloneOwner(ctx, await getClone(ctx.db, id), wasStopped ? 'started' : 'restarted', wasStopped ? '▶️' : '🔁', wasStopped ? 'Clone Bot Started' : 'Clone Bot Restarted', [`🤖 ${esc(row.bot_name)}`, '🟢 Running (started by Main Owner)']);
        return show(ctx, cq, await detailScreen(ctx, id), 'Running.');
      }
      case 'ba':
      case 'bd': {
        const clone = await getClone(ctx.db, id);
        if (!clone || clone.status === 'removed') return ctx.tg.answerCallbackQuery(cq.id, 'Clone not found.', true);
        const approve = action === 'ba';
        await updateClone(ctx.db, id, { broadcast_approved: approve ? 1 : 0 });
        await logAudit(ctx.db, { actor: cq.from.id, action: approve ? 'clone_broadcast_on' : 'clone_broadcast_off', target: id });
        await notifyCloneOwner(ctx, await getClone(ctx.db, id), 'broadcast', approve ? '✅' : '❌', approve ? 'Broadcast Request Accepted' : 'Broadcast Request Denied', [`🤖 ${esc(clone.bot_name)}`, approve ? '✅ The Main Owner accepted. Your clone can now broadcast (text messages).' : '❌ The Main Owner denied the broadcast request.']);
        await ctx.tg.editMessageText(cq.message.chat.id, cq.message.message_id, `${box(approve ? '✅' : '❌', approve ? 'Accepted' : 'Denied')}\n\n${blockquote(esc(clone.bot_name))}`).catch(() => {});
        return ctx.tg.answerCallbackQuery(cq.id, approve ? 'Accepted.' : 'Denied.', false);
      }
      case 'b': {
        const clone = await getClone(ctx.db, id);
        if (!clone) return ctx.tg.answerCallbackQuery(cq.id, 'Clone not found.', true);
        const approve = !clone.broadcast_approved;
        await updateClone(ctx.db, id, { broadcast_approved: approve ? 1 : 0 });
        await logAudit(ctx.db, { actor: cq.from.id, action: approve ? 'clone_broadcast_on' : 'clone_broadcast_off', target: id });
        await notifyCloneOwner(ctx, await getClone(ctx.db, id), 'broadcast', '📣', approve ? 'Broadcast Permission Approved' : 'Broadcast Permission Removed', [`🤖 ${esc(clone.bot_name)}`, approve ? '✅ The Main Owner approved broadcast for your clone.' : '🚫 Broadcast permission was removed by the Main Owner.']);
        return show(ctx, cq, await detailScreen(ctx, id), approve ? 'Broadcast approved.' : 'Broadcast removed.');
      }
      case 'R': {
        const clone = await getClone(ctx.db, id);
        if (!clone) return ctx.tg.answerCallbackQuery(cq.id, 'Clone not found.', true);
        return show(ctx, cq, {
          text: `${box('⚠️', 'Remove clone?')}\n\n${blockquote(`🤖 ${esc(clone.bot_name)}\nThe bot is switched off and its token is removed from this system. Its database is not deleted.`)}`,
          keyboard: markup([[btn('✅ Yes, remove', `cm:Ry:${id}`, { style: 'danger' }), btn('Cancel', `cm:v:${id}`, { style: 'primary' })]]),
        });
      }
      case 'Ry': {
        const row = await getCloneSecrets(ctx.db, id);
        if (!row || row.status === 'removed') return ctx.tg.answerCallbackQuery(cq.id, 'Clone not found.', true);
        await deleteCloneWebhook(await decryptSecret(ctx.config.cloneKey, row.token_enc)).catch(() => {});
        await updateClone(ctx.db, id, { status: 'removed', removed_at: Math.floor(Date.now() / 1000), stopped_by: 'main', last_error: null });
        await ctx.db.execute('UPDATE clones SET token_enc = NULL, webhook_secret_enc = NULL WHERE id = ?', [id]);
        await logAudit(ctx.db, { actor: cq.from.id, action: 'clone_remove', target: id });
        await notifyCloneOwner(ctx, await getClone(ctx.db, id), 'removed', '🗑', 'Clone Bot Removed', [`🤖 ${esc(row.bot_name)}`, '✅ Removed by the Main Owner']);
        return show(ctx, cq, await listScreen(ctx, 0), 'Removed.');
      }
      default: return ctx.tg.answerCallbackQuery(cq.id, 'Unknown button.', true);
    }
  } catch (e) {
    await recordError(ctx, 'clones panel', e);
    return ctx.tg.answerCallbackQuery(cq.id, 'Something went wrong. Please try again.', true);
  }
}

