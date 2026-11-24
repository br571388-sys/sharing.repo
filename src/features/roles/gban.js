import { queueLog, who } from '../../core/activityLog.js';
// Global bans: /gban /ungban /gbanlist /gbaninfo (moderators = owner + sudo users).
//
// How it works (and what it deliberately does NOT claim):
//  * A global ban is stored once (global_bans) and then queued per group (global_ban_results).
//  * The queue is processed immediately in a bounded batch and continued by the 1-minute cron, so large group
//    lists never block a webhook and survive Worker restarts.
//  * A group counts as "banned" only when Telegram confirmed banChatMember there. Groups where the bot lacks the
//    ban right, was removed, or where the target is an administrator are reported as skipped/failed - never as success.
//  * Users who join a group later are banned on arrival; groups the bot is added to later are queued too.

import { syncGbanToClones } from '../clones/gbanSync.js';
import { nowSec } from '../../utils/helpers.js';
import { botMember } from '../groupmgmt/util.js';
import {
  activeGroupChatIds, countGlobalBans, createGlobalBan, failedResults, getGlobalBan, isGloballyBanned, listGlobalBans,
  liftGlobalBan, logAudit, pendingResults, queueBanResults, queueUnbanResults, resultSummary, setResult, isSudoUser,
} from '../../database/roles.js';
import { backCloseRow, btn, closeBtn, markup, pagerRow } from '../../keyboards/inlineKeyboard.js';
import { blockquote, box, row } from '../../ui/design.js';
import { esc, messages } from '../../utils/formatter.js';
import { reply, safeEdit } from '../../handlers/helpers.js';
import { formatDateTimeIST } from '../../services/timezone.js';
import { isBotOwner } from '../../core/permissions.js';
import { getRole, isModeratorRole } from '../../core/roles.js';
import { resolveTarget, userLabel } from '../groupmgmt/util.js';
import { logger } from '../../utils/logger.js';

const BATCH = 20; // groups handled inline per command / per cron tick
const MAX_ATTEMPTS = 3;
const PAGE = 6;

const msgOf = (e) => String(e?.message || 'unknown error');

/** Why can't the bot ban in this chat? Returns '' when it can. Memoised per run in `cache`. */
async function banBlocker(ctx, chatId, cache) {
  if (cache.has(chatId)) return cache.get(chatId);
  let why = '';
  try {
    const me = await botMember(ctx, chatId);
    if (!me) why = 'bot cannot access the group (removed or no access)';
    else if (!['administrator', 'creator'].includes(me.status)) why = 'bot is not an administrator';
    else if (me.status === 'administrator' && me.can_restrict_members === false) why = 'bot lacks the "ban users" right';
  } catch (e) {
    why = /chat not found|kicked|not a member|forbidden/i.test(msgOf(e)) ? 'bot was removed from the group' : `cannot read bot rights (${msgOf(e)})`;
  }
  cache.set(chatId, why);
  return why;
}

/** Applies ONE queued operation and records the real outcome. Returns the final status. */
async function applyOne(ctx, r, cache) {
  const chatId = Number(r.chat_id);
  const userId = Number(r.user_id);
  const unban = r.status === 'unban_pending';
  const blocker = await banBlocker(ctx, chatId, cache);
  if (blocker) {
    const status = unban ? 'lifted' : 'skipped'; // nothing the bot can undo where it has no rights
    await setResult(ctx.db, userId, chatId, status, blocker);
    return status;
  }
  try {
    if (unban) {
      await ctx.tg.unbanChatMember(chatId, userId, true);
      await setResult(ctx.db, userId, chatId, 'lifted');
      return 'lifted';
    }
    const member = await ctx.tg.getChatMember(chatId, userId).catch(() => null);
    if (member && ['administrator', 'creator'].includes(member.status)) {
      await setResult(ctx.db, userId, chatId, 'skipped', 'target is an administrator of that group');
      return 'skipped';
    }
    await ctx.tg.banChatMember(chatId, userId);
    await setResult(ctx.db, userId, chatId, 'ok');
    return 'ok';
  } catch (e) {
    const m = msgOf(e);
    if (/chat not found|bot was kicked|not a member of the (?:chat|supergroup)|forbidden/i.test(m)) { await setResult(ctx.db, userId, chatId, 'skipped', 'bot was removed from the group'); return 'skipped'; }
    const transient = Boolean(e?.retryAfter) || /timed out|network|too many requests|50\d/i.test(m);
    const attempts = Number(r.attempts || 0) + 1;
    if (transient && attempts < MAX_ATTEMPTS) { await setResult(ctx.db, userId, chatId, r.status, m); return 'pending'; }
    await setResult(ctx.db, userId, chatId, 'failed', m);
    return 'failed';
  }
}

/** Processes up to `limit` queued operations (all users, or one). Returns counts. */
export async function processGbanQueue(ctx, { limit = BATCH, userId = null } = {}) {
  const out = { ok: 0, failed: 0, skipped: 0, pending: 0, lifted: 0 };
  const cache = new Map();
  for (const r of await pendingResults(ctx.db, limit, userId)) {
    const status = await applyOne(ctx, r, cache);
    out[status] = (out[status] || 0) + 1;
  }
  return out;
}

/** Cron entry point. */
export const runGbanJob = (ctx) => processGbanQueue(ctx, { limit: 25 });

/** A globally banned user just joined `chat`: ban them right away. Returns true when they were removed. */
export async function enforceGbanOnJoin(ctx, chat, user) {
  if (!(await isGloballyBanned(ctx.db, user.id))) return false;
  await queueBanResults(ctx.db, user.id, [chat.id]);
  const status = await applyOne(ctx, { user_id: user.id, chat_id: chat.id, status: 'pending', attempts: 0 }, new Map());
  return status === 'ok';
}

/** The bot was added to a new group: queue every active global ban there. */
export async function queueActiveGbansForGroup(ctx, chatId) {
  const bans = await listGlobalBans(ctx.db, 200, 0);
  for (const b of bans) await queueBanResults(ctx.db, b.user_id, [chatId]);
  return bans.length;
}

// ------------------------------------------------------------------ rendering

function summaryRows(s, total) {
  return [
    row('✅', 'Banned (confirmed)', String(s.ok)),
    s.failed ? row('❌', 'Failed', String(s.failed)) : '',
    s.skipped ? row('⏭', 'Skipped', String(s.skipped)) : '',
    s.pending ? row('⏳', 'Still queued', String(s.pending)) : '',
    row('👥', 'Groups checked', String(total)),
  ].filter(Boolean).join('\n');
}

async function failureLines(ctx, userId) {
  const f = await failedResults(ctx.db, userId, 5);
  if (!f.length) return '';
  return `\n\n<b>Not applied in:</b>\n${f.map((x) => `• <code>${x.chat_id}</code> — ${esc(String(x.error || x.status).slice(0, 80))}`).join('\n')}`;
}

async function resultText(ctx, titleEmoji, title, userId, extra = '') {
  const s = await resultSummary(ctx.db, userId);
  const total = s.ok + s.failed + s.skipped + s.pending + s.lifted;
  return `${box(titleEmoji, title)}\n\n${row('👤', 'User', `<code>${userId}</code>`, { raw: true })}\n${extra}${summaryRows(s, total)}${s.pending ? '\n\n🕒 <i>The remaining groups are processed automatically in the background.</i>' : ''}${await failureLines(ctx, userId)}`;
}

// ------------------------------------------------------------------ commands

const usage = (n) => messages.usage(n === 'gban' ? ['/gban USER_ID [reason]', '/gban [reason] (reply to a user)'] : [`/${n} USER_ID`], n === 'gban' ? ['/gban 123456789 spam bot'] : [`/${n} 123456789`]);

async function protectedFromGban(ctx, id) {
  if (isBotOwner(ctx.config, id)) return 'The bot owner cannot be globally banned.';
  if (await isSudoUser(ctx.db, id)) return 'A sudo moderator cannot be globally banned. Remove their sudo rank first (owner only).';
  return '';
}

export async function gbanCommand(ctx, msg, args) {
  const t = await resolveTarget(ctx, msg, args);
  if (!t.ok) return reply(ctx, msg, t.error || usage('gban'));
  const id = t.target.id;
  const info = await ctx.botInfo().catch(() => null);
  const guard = id === info?.id ? 'I cannot globally ban myself.' : await protectedFromGban(ctx, id);
  if (guard) return reply(ctx, msg, messages.warning('Not Allowed', guard));
  if (t.target.user?.is_bot) return reply(ctx, msg, messages.warning('Not Allowed', 'Bots cannot be globally banned.'));
  const reason = (t.rest || '').trim().slice(0, 300) || null;

  const created = await createGlobalBan(ctx.db, { userId: id, moderator: msg.from.id, reason });
  if (!created) return reply(ctx, msg, messages.warning('Already Globally Banned', `User ${id} is already on the global ban list. Use /gbaninfo ${id} for details.`));
  const chats = await activeGroupChatIds(ctx.db);
  await queueBanResults(ctx.db, id, chats);
  await logAudit(ctx.db, { actor: msg.from.id, action: 'gban', target: id, detail: reason });
  if (!ctx.clone) await syncGbanToClones(ctx, { userId: id, status: 'active', moderatorId: msg.from.id, reason, createdAt: nowSec() });
  queueLog(ctx, `🌐 <b>global ban</b> <code>${id}</code> · ${who(msg.from)} · ${esc(reason || 'no reason')} · ${chats.length} group(s)`);
  logger.info('global ban', { target: id, by: msg.from.id, groups: chats.length });
  await processGbanQueue(ctx, { limit: BATCH, userId: id });
  const extra = `${row('🛡', 'Moderator', userLabel(msg.from), { raw: true })}\n${row('📝', 'Reason', reason || 'No reason given')}\n${row('🕒', 'Time', formatDateTimeIST(Math.floor(Date.now() / 1000)))}\n`;
  return reply(ctx, msg, await resultText(ctx, '🚫', 'Global Ban', id, extra), { reply_markup: markup([[btn('🔎 Info', `gb:i:${id}`), closeBtn()]]) });
}

export async function ungbanCommand(ctx, msg, args) {
  const t = await resolveTarget(ctx, msg, args);
  if (!t.ok) return reply(ctx, msg, t.error || usage('ungban'));
  const id = t.target.id;
  const lifted = await liftGlobalBan(ctx.db, id, msg.from.id);
  if (!lifted) return reply(ctx, msg, messages.warning('Not Globally Banned', `User ${id} has no active global ban.`));
  await queueUnbanResults(ctx.db, id);
  await logAudit(ctx.db, { actor: msg.from.id, action: 'ungban', target: id });
  if (!ctx.clone) await syncGbanToClones(ctx, { userId: id, status: 'lifted', moderatorId: msg.from.id, reason: null, createdAt: nowSec(), liftedBy: msg.from.id, liftedAt: nowSec() });
  queueLog(ctx, `🌐 <b>global ban lifted</b> <code>${id}</code> · ${who(msg.from)}`);
  await processGbanQueue(ctx, { limit: BATCH, userId: id });
  const s = await resultSummary(ctx.db, id);
  return reply(ctx, msg, `${box('✅', 'Global Ban Lifted')}\n\n${row('👤', 'User', `<code>${id}</code>`, { raw: true })}\n${row('🔓', 'Unbanned in', `${s.lifted} group(s)`)}${s.pending ? `\n${row('⏳', 'Still queued', String(s.pending))}` : ''}${s.failed ? `\n${row('❌', 'Failed', String(s.failed))}` : ''}`, { reply_markup: markup([[closeBtn()]]) });
}

async function infoScreen(ctx, id) {
  const b = await getGlobalBan(ctx.db, id);
  if (!b) return { text: messages.warning('No Record', `User ${id} was never globally banned.`), keyboard: markup([[closeBtn()]]) };
  const when = (s) => formatDateTimeIST(Number(s));
  const base = [
    row('👤', 'User', `<code>${id}</code>`, { raw: true }),
    row('📌', 'Status', b.status === 'active' ? '🔴 Globally banned' : '🟢 Lifted'),
    row('🛡', 'Moderator', `<code>${b.moderator_id}</code>`, { raw: true }),
    row('📝', 'Reason', b.reason || 'No reason given'),
    row('🕒', 'Banned at', when(b.created_at)),
    b.lifted_at ? row('🔓', 'Lifted at', `${when(b.lifted_at)} by ${b.lifted_by}`) : '',
  ].filter(Boolean).join('\n');
  const s = await resultSummary(ctx.db, id);
  const total = s.ok + s.failed + s.skipped + s.pending + s.lifted;
  const detail = `${row('✅', 'Confirmed bans', String(s.ok))}\n${row('❌', 'Failed', String(s.failed))}\n${row('⏭', 'Skipped', String(s.skipped))}\n${row('⏳', 'Queued', String(s.pending))}\n${row('🔓', 'Lifted', String(s.lifted))}\n${row('👥', 'Groups tracked', String(total))}`;
  return {
    text: `${box('🔎', 'Global Ban Info')}\n\n${base}\n\n${blockquote(detail)}${await failureLines(ctx, id)}\n\n💡 <i>A global ban is separate from the normal /ban of a single group.</i>`,
    keyboard: markup([[btn('◀️ Back', 'gb:l:0'), closeBtn()]]),
  };
}

export async function gbaninfoCommand(ctx, msg, args) {
  const t = await resolveTarget(ctx, msg, args);
  if (!t.ok) return reply(ctx, msg, t.error || usage('gbaninfo'));
  const s = await infoScreen(ctx, t.target.id);
  return reply(ctx, msg, s.text, { reply_markup: s.keyboard });
}

export async function gbanListScreen(ctx, page = 0) {
  const total = await countGlobalBans(ctx.db);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const p = Math.min(Math.max(Number(page) || 0, 0), pages - 1);
  const rows = await listGlobalBans(ctx.db, PAGE, p * PAGE);
  const body = rows.length
    ? rows.map((b, i) => `<b>${p * PAGE + i + 1}.</b> <code>${b.user_id}</code> — ${esc(String(b.reason || 'no reason').slice(0, 60))}\n    <i>${formatDateTimeIST(Number(b.created_at))}</i>`).join('\n')
    : 'Nobody is globally banned right now.';
  const kb = rows.map((b) => [btn(`🔎 ${b.user_id}`, `gb:i:${b.user_id}`, { plain: false, style: 'primary' })]);
  const pager = pagerRow(p, pages, (n) => `gb:l:${n}`);
  if (pager.length) kb.push(pager);
  kb.push([closeBtn()]);
  return { text: `${box('🚫', 'Global Ban List')}\n\n${row('📊', 'Active global bans', String(total))}\n\n${blockquote(body)}`, keyboard: markup(kb) };
}

export async function gbanlistCommand(ctx, msg) {
  const s = await gbanListScreen(ctx, 0);
  return reply(ctx, msg, s.text, { reply_markup: s.keyboard });
}

/** gb:l:<page> | gb:i:<userId> — every tap re-checks that the tapper is still a moderator. */
export async function gbanCallback(ctx, cq, parts) {
  if (!isModeratorRole(await getRole(ctx, cq.from.id))) return ctx.tg.answerCallbackQuery(cq.id, '🔒 Moderators only.', true);
  const m = cq.message;
  const screen = parts[1] === 'i' && /^\d{1,15}$/.test(parts[2] || '') ? await infoScreen(ctx, Number(parts[2])) : parts[1] === 'l' ? await gbanListScreen(ctx, parts[2]) : null;
  if (!screen) return ctx.tg.answerCallbackQuery(cq.id, 'Unknown button.');
  await ctx.tg.answerCallbackQuery(cq.id);
  await safeEdit(ctx, m.chat.id, m.message_id, screen.text, { reply_markup: screen.keyboard });
  return undefined;
}

