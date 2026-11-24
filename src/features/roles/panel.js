import { queueLog, who } from '../../core/activityLog.js';
// /panel — the moderator dashboard. Everything shown is read from the database; nothing is invented.
// Moderators (owner + sudo) see stats, users, groups, bans and recent activity; only the owner sees sudo management.
// Every callback re-checks the tapper's role, so a forwarded panel never works for someone who lost access.

import {
  countAudit, countGlobalBans, dashboardStats, isSudoUser, listGlobalBans, listSudoUsers, logAudit, recentAudit, removeSudoUser, usageLastDays,
} from '../../database/roles.js';
import { forgetRole, getRole, isModeratorRole, isOwnerRole } from '../../core/roles.js';
import { CAPTAIN_PERMS, captainPerms, isCaptain, setCaptain, setCaptainPerm } from '../../core/captains.js';
import { createPending, deletePendingForUser, getPendingForUser, takePending } from '../../database/state.js';
import { backCloseRow, btn, closeBtn, markup, pagerRow } from '../../keyboards/inlineKeyboard.js';
import { blockquote, box, row } from '../../ui/design.js';
import { esc, messages } from '../../utils/formatter.js';
import { reply, safeEdit, visibleLength } from '../../handlers/helpers.js';
import { recordError } from '../../core/errorHandler.js';
import { formatDateTimeIST } from '../../services/timezone.js';
import { setModeratorMenu } from './sudo.js';
import { replyButtonMarkup } from './reply.js';
import { CONTROL_VIEWS, controlScreen, toggleControl } from './controls.js';
import { personButton, personHtml, personInfo } from './people.js';

const PAGE = 6;
const n = (v) => Number(v).toLocaleString('en-US');
const pageOf = (page, total) => { const pages = Math.max(1, Math.ceil(total / PAGE)); return { pages, p: Math.min(Math.max(Number(page) || 0, 0), pages - 1) }; };

export async function mainScreen(ctx, role) {
  const s = await dashboardStats(ctx.db);
  const stats = [
    row('👥', 'Total users', n(s.users)), row('🟢', 'Active users', n(s.activeUsers)), row('🆕', 'New today', n(s.newUsersToday)),
    row('💬', 'Groups', `${n(s.activeGroups)} active / ${n(s.groups)} total`),
    row('⌨️', 'Commands used', `${n(s.commandsTotal)} (today ${n(s.commandsToday)})`),
    row('🚫', 'Failed API calls', `${n(s.apiFailTotal)} (today ${n(s.apiFailToday)})`),
    row('🚫', 'Banned in groups', n(s.groupBans)), row('🌐', 'Global bans', n(s.globalBans)),
    row('⚠️', 'Active warnings', n(s.warnings)), row('🔨', 'Moderation actions', `${n(s.modActions)} (today ${n(s.modActionsToday)})`),
    row('🛡', 'Sudo moderators', n(s.sudo)),
  ].join('\n');
  const rows = [
    [btn('👤 User Stats', 'pn:u:0', { style: 'primary' }), btn('👥 Group Stats', 'pn:g:0', { style: 'primary' })],
    [btn('🚫 Banned Users', 'pn:b:0', { style: 'danger' }), isOwnerRole(role) ? btn('🛡 Sudo Management', 'pn:sd:0', { style: 'primary' }) : btn('📈 Usage', 'pn:ua', { style: 'primary' })],
    [btn('🕘 Recent Activity', 'pn:a:0', { style: 'primary' }), btn('🔄 Refresh', 'pn:m', { style: 'primary' })],
    ...(isOwnerRole(role) && !ctx.clone ? [[btn('🎛 Bot Controls', 'pn:ct', { style: 'primary' })]] : []),
    [closeBtn()],
  ];
  return { text: `${box('📊', `${ctx.config.botName} Moderator Panel`)}\n\n${blockquote(stats)}\n\n🕒 <i>${formatDateTimeIST(Math.floor(Date.now() / 1000))}</i>`, keyboard: markup(rows) };
}

async function usersScreen(ctx, page) {
  const s = await dashboardStats(ctx.db);
  const blocked = s.users - s.activeUsers;
  const { pages, p } = pageOf(page, s.users);
  const list = await ctx.db.all('SELECT telegram_user_id AS id, first_name, username, created_at FROM users ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', [PAGE, p * PAGE]);
  const body = list.length ? list.map((u) => `• <code>${u.id}</code> ${esc(String(u.first_name || '').slice(0, 24))}${u.username ? ` (@${esc(u.username)})` : ''}`).join('\n') : 'No users yet.';
  const kb = [];
  const pg = pagerRow(p, pages, (x) => `pn:u:${x}`); if (pg.length) kb.push(pg);
  kb.push(backCloseRow('pn:m'));
  return { text: `${box('👤', 'User Stats')}\n\n${blockquote([row('👥', 'Total', n(s.users)), row('🟢', 'Active', n(s.activeUsers)), row('⛔', 'Blocked the bot', n(blocked)), row('🆕', 'New in 24h', n(s.newUsersToday))].join('\n'))}\n\n<b>Newest users</b>${pages > 1 ? ` (${p + 1}/${pages})` : ''}\n${body}`, keyboard: markup(kb) };
}

async function groupsScreen(ctx, page) {
  const s = await dashboardStats(ctx.db);
  const { pages, p } = pageOf(page, s.groups);
  const list = await ctx.db.all('SELECT telegram_chat_id AS id, title, is_active FROM groups ORDER BY is_active DESC, joined_at DESC LIMIT ? OFFSET ?', [PAGE, p * PAGE]);
  const body = list.length ? list.map((g) => `${g.is_active ? '🟢' : '⚪'} ${esc(String(g.title || 'Untitled').slice(0, 30))} — <code>${g.id}</code>`).join('\n') : 'The bot is not in any group yet.';
  const kb = [];
  const pg = pagerRow(p, pages, (x) => `pn:g:${x}`); if (pg.length) kb.push(pg);
  kb.push(backCloseRow('pn:m'));
  return { text: `${box('👥', 'Group Stats')}\n\n${blockquote([row('💬', 'Total groups', n(s.groups)), row('🟢', 'Active', n(s.activeGroups)), row('⚪', 'Left / removed', n(s.groups - s.activeGroups))].join('\n'))}\n\n<b>Groups</b>${pages > 1 ? ` (${p + 1}/${pages})` : ''}\n${body}`, keyboard: markup(kb) };
}

async function bannedScreen(ctx, page) {
  const s = await dashboardStats(ctx.db);
  const total = await countGlobalBans(ctx.db);
  const { pages, p } = pageOf(page, total);
  const list = await listGlobalBans(ctx.db, PAGE, p * PAGE);
  const body = list.length ? list.map((b) => `• <code>${b.user_id}</code> — ${esc(String(b.reason || 'no reason').slice(0, 50))}`).join('\n') : 'No global bans.';
  const kb = list.map((b) => [btn(`🔎 ${b.user_id}`, `gb:i:${b.user_id}`, { style: 'primary' })]);
  const pg = pagerRow(p, pages, (x) => `pn:b:${x}`); if (pg.length) kb.push(pg);
  kb.push(backCloseRow('pn:m'));
  return { text: `${box('🚫', 'Banned Users')}\n\n${blockquote([row('🌐', 'Global bans', n(total)), row('🔨', 'Active group bans', n(s.groupBans))].join('\n'))}\n\n<b>Globally banned</b>${pages > 1 ? ` (${p + 1}/${pages})` : ''}\n${body}\n\n💡 <i>/gban · /ungban · /gbaninfo</i>`, keyboard: markup(kb) };
}

async function activityScreen(ctx, page) {
  const total = await countAudit(ctx.db);
  const { pages, p } = pageOf(page, total);
  const list = await recentAudit(ctx.db, PAGE, p * PAGE);
  const body = list.length
    ? list.map((a) => `• <b>${esc(a.action)}</b>${a.target_id ? ` → <code>${a.target_id}</code>` : ''} by <code>${a.actor_id}</code>\n  <i>${formatDateTimeIST(Number(a.created_at))}</i>`).join('\n')
    : 'No moderator activity recorded yet.';
  const kb = [];
  const pg = pagerRow(p, pages, (x) => `pn:a:${x}`); if (pg.length) kb.push(pg);
  kb.push(backCloseRow('pn:m'));
  return { text: `${box('🕘', 'Recent Activity')}\n\n${blockquote(body)}${pages > 1 ? `\n\nPage ${p + 1}/${pages}` : ''}`, keyboard: markup(kb) };
}

async function usageScreen(ctx) {
  const days = await usageLastDays(ctx.db, 7);
  const body = days.length ? days.map((d) => `• ${esc(d.day)} — <b>${n(d.n)}</b> commands`).join('\n') : 'No usage recorded yet.';
  return { text: `${box('📈', 'Daily Usage')}\n\n${blockquote(body)}`, keyboard: markup([backCloseRow('pn:m')]) };
}

// The /start welcome can be a photo, a video or a GIF: all of them keep their text in the caption.
const isMediaMessage = (m) => Boolean(m && (m.photo?.length || m.video || m.animation || m.document));

const SUDO_PAGE = 5;
const OWNER_VIEWS = new Set(['sd', 'su', 'sr', 'sy', 'sm', 'cp', 'cd', 'cx']);

async function sudoScreen(ctx, page = 0) {
  const all = await listSudoUsers(ctx.db);
  const { pages, p } = pageOf(page, all.length);
  const list = all.slice(p * SUDO_PAGE, (p + 1) * SUDO_PAGE);
  const infos = await Promise.all(list.map((u) => personInfo(ctx, u.user_id)));
  const body = list.length ? list.map((u, i) => `<b>${p * SUDO_PAGE + i + 1}.</b> ${personHtml(infos[i], u.user_id)}\n   <i>added ${formatDateTimeIST(Number(u.added_at))}</i>`).join('\n') : 'No sudo moderators yet.';
  const kb = list.map((u, i) => [btn(`⚙️ ${personButton(infos[i], u.user_id)}`, `pn:su:${u.user_id}`, { style: 'primary' })]);
  const pg = pagerRow(p, pages, (x) => `pn:sd:${x}`); if (pg.length) kb.push(pg);
  kb.push(backCloseRow('pn:m'));
  return { text: `${box('🛡', 'Sudo Management')}\n\n${row('👑', 'Main owner', `<code>${ctx.config.ownerId}</code>`, { raw: true })}\n${row('🛡', 'Sudo moderators', n(all.length))}\n\n${blockquote(body)}${pages > 1 ? `\n\nPage ${p + 1}/${pages}` : ''}\n\n💡 <i>Add one with /sudo add USER_ID</i>`, keyboard: markup(kb) };
}

/** The per-moderator controls (owner only): promote/demote, send a message, remove. */
async function personScreen(ctx, id) {
  const person = await personInfo(ctx, id);
  const captain = await isCaptain(ctx.db, id);
  const perms = captain ? await captainPerms(ctx.db, id) : [];
  const rows = [
    [captain
      ? btn('⬇️ Demote to Sudo', `pn:cd:${id}`, { style: 'primary' })
      : btn('⬆️ Promote to Captain', `pn:cp:${id}`, { style: 'success' })],
  ];
  if (captain) {
    rows.push(...Object.entries(CAPTAIN_PERMS).map(([key, p]) => [
      btn(`${perms.includes(key) ? '✅' : '⬜'} ${p.label}`, `pn:cx:${id}:${key}`, { style: perms.includes(key) ? 'success' : 'primary' }),
    ]));
  }
  rows.push([btn('✉️ Send message', `pn:sm:${id}`, { style: 'primary' })]);
  rows.push([btn('🗑 Remove sudo', `pn:sr:${id}`, { style: 'danger' })]);
  rows.push(backCloseRow('pn:sd:0'));
  const permText = captain
    ? `\n\n<b>Captain permissions</b> — tap to allow or stop:\n${Object.entries(CAPTAIN_PERMS).map(([k, p]) => `${perms.includes(k) ? '✅' : '⬜'} ${p.label}: <code>${p.commands}</code>`).join('\n')}\n\n💡 <i>Broadcast is always on for captains.</i>`
    : '';
  return {
    text: `${box('⚙️', 'Moderator Controls')}\n\n${row('🏷', 'Rank', captain ? '🎖 Captain' : '🛡 Sudo moderator')}\n\n${blockquote(personHtml(person, id))}${permText}`,
    keyboard: markup(rows),
  };
}

/** Owner's next private message after "Send message" is copied to the moderator. Returns true when it was handled. */
export async function relayPanelMessage(ctx, msg) {
  const pending = await getPendingForUser(ctx.db, 'panel_msg', msg.from.id);
  if (!pending) return false;
  if (typeof msg.text === 'string' && msg.text.startsWith('/')) return false; // commands still run normally
  const target = Number(pending.payload.target);
  const back = markup([backCloseRow(`pn:su:${target}`)]);
  try {
    await ctx.tg.sendMessage(target, blockquote('📩 The bot owner sent you this message:'));
    await ctx.tg.call('copyMessage', { chat_id: target, from_chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: replyButtonMarkup(msg.from.id) });
  } catch (e) {
    await recordError(ctx, 'panel message', e);
    await reply(ctx, msg, messages.warning('Not Delivered', 'Telegram did not deliver the message. The moderator may have blocked the bot.'), { reply_markup: back });
    return true;
  }
  await takePending(ctx.db, pending.id, 'panel_msg');
  await logAudit(ctx.db, { actor: msg.from.id, action: 'sudo_message', target });
  queueLog(ctx, `✉️ <b>message sent to moderator</b> <code>${target}</code> · by ${who(msg.from)} (panel)`);
  await reply(ctx, msg, messages.success('Message Sent', `Your message was delivered to <code>${target}</code>.`), { reply_markup: back });
  return true;
}

export async function panelCommand(ctx, msg) {
  if (msg.chat.type !== 'private') return reply(ctx, msg, messages.warning('Private Chat Only', 'Open the moderator panel in a private chat with me.'));
  const role = await getRole(ctx, msg.from.id);
  if (!isModeratorRole(role)) return reply(ctx, msg, messages.denied('Only moderators can use this command.'));
  const s = await mainScreen(ctx, role);
  return reply(ctx, msg, s.text, { reply_markup: s.keyboard });
}

/** pn:m | pn:u:<page> | pn:g:<page> | pn:b:<page> | pn:a:<page> | pn:ua | pn:sd:0 | pn:su:<id> | pn:sr:<id> | pn:sy:<id> | pn:sm:<id> | pn:cp:<id> | pn:cd:<id> */
export async function panelCallback(ctx, cq, parts) {
  try {
    return await panelCallbackInner(ctx, cq, parts);
  } catch (e) {
    await recordError(ctx, 'panel', e);
    return ctx.tg.answerCallbackQuery(cq.id, 'The panel could not refresh. Send /panel again.', true);
  }
}

async function panelCallbackInner(ctx, cq, parts) {
  const role = await getRole(ctx, cq.from.id);
  if (!isModeratorRole(role)) return ctx.tg.answerCallbackQuery(cq.id, '🔒 Moderators only.', true);
  const m = cq.message;
  const view = parts[1];
  let screen = null;
  let toast;
  if (view === 'm') screen = await mainScreen(ctx, role);
  else if (view === 'u') screen = await usersScreen(ctx, parts[2]);
  else if (view === 'g') screen = await groupsScreen(ctx, parts[2]);
  else if (view === 'b') screen = await bannedScreen(ctx, parts[2]);
  else if (view === 'a') screen = await activityScreen(ctx, parts[2]);
  else if (view === 'ua') screen = await usageScreen(ctx);
  else if (CONTROL_VIEWS.has(view)) {
    if (!isOwnerRole(role)) return ctx.tg.answerCallbackQuery(cq.id, '🔒 Only the main owner can change bot controls.', true);
    if (view !== 'ct') toast = await toggleControl(ctx, view, cq.from);
    screen = await controlScreen(ctx);
  }
  else if (OWNER_VIEWS.has(view)) {
    if (!isOwnerRole(role)) return ctx.tg.answerCallbackQuery(cq.id, '🔒 Only the main owner can manage sudo moderators.', true);
    const id = Number(parts[2]);
    const known = Number.isInteger(id) && await isSudoUser(ctx.db, id);
    if (view === 'sd') screen = await sudoScreen(ctx, parts[2]);
    else if (!Number.isInteger(id)) return ctx.tg.answerCallbackQuery(cq.id, 'Unknown button.');
    else if (!known && view !== 'sy') {
      toast = 'This person is no longer a moderator.';
      screen = await sudoScreen(ctx);
    } else if (view === 'su') {
      await deletePendingForUser(ctx.db, 'panel_msg', cq.from.id); // leaving the message prompt cancels it
      screen = await personScreen(ctx, id);
    } else if (view === 'cp' || view === 'cd') {
      const on = view === 'cp';
      await setCaptain(ctx.db, id, on);
      await logAudit(ctx.db, { actor: cq.from.id, action: on ? 'captain_promote' : 'captain_demote', target: id });
      queueLog(ctx, `🎖 <b>${on ? 'captain promoted' : 'captain demoted to sudo'}</b> <code>${id}</code> · by ${who(cq.from)} (panel)`);
      toast = on ? 'Promoted to captain.' : 'Demoted to sudo moderator.';
      screen = await personScreen(ctx, id);
    } else if (view === 'cx') {
      const key = parts[3];
      if (!(await isCaptain(ctx.db, id)) || !(key in CAPTAIN_PERMS)) { toast = 'Make this person a captain first.'; screen = await personScreen(ctx, id); }
      else {
        const on = !(await captainPerms(ctx.db, id)).includes(key);
        await setCaptainPerm(ctx.db, id, key, on);
        await logAudit(ctx.db, { actor: cq.from.id, action: on ? 'captain_perm_on' : 'captain_perm_off', target: id, detail: key });
        queueLog(ctx, `🎖 <b>captain permission ${on ? 'given' : 'removed'}</b> <code>${id}</code> · ${key} · by ${who(cq.from)} (panel)`);
        toast = `${CAPTAIN_PERMS[key].label} ${on ? 'allowed' : 'stopped'}.`;
        screen = await personScreen(ctx, id);
      }
    } else if (view === 'sm') {
      await deletePendingForUser(ctx.db, 'panel_msg', cq.from.id);
      await createPending(ctx.db, { kind: 'panel_msg', userId: cq.from.id, chatId: m.chat.id, payload: { target: id }, ttlSec: 900 });
      const person = await personInfo(ctx, id);
      screen = {
        text: `${box('✉️', 'Send Message')}\n\n${blockquote(personHtml(person, id))}\n\nSend your next message here and I will deliver it to this moderator. Text, photos, videos and files all work. Tap Back to cancel.`,
        keyboard: markup([backCloseRow(`pn:su:${id}`)]),
      };
    } else if (view === 'sr') {
      const person = await personInfo(ctx, id);
      screen = { text: `${box('⚠️', 'Remove Sudo Moderator')}\n\nRemove moderator access from ${personHtml(person, id)}?`, keyboard: markup([[btn('✅ Yes, remove', `pn:sy:${id}`, { style: 'danger' }), btn('Cancel', `pn:su:${id}`, { style: 'danger' })]]) };
    } else if (view === 'sy') {
      if (await removeSudoUser(ctx.db, id)) {
        forgetRole(ctx, id);
        await setCaptain(ctx.db, id, false);
        await logAudit(ctx.db, { actor: cq.from.id, action: 'sudo_remove', target: id });
        queueLog(ctx, `🛡 <b>sudo removed</b> <code>${id}</code> · by ${who(cq.from)} (panel)`);
        await setModeratorMenu(ctx, id, false);
        toast = 'Sudo moderator removed.';
      }
      screen = await sudoScreen(ctx);
    }
  }
  if (!screen) return ctx.tg.answerCallbackQuery(cq.id, 'Unknown button.');
  await ctx.tg.answerCallbackQuery(cq.id, toast);
  if (isMediaMessage(m)) {
    // Opened from the /start picture: edit the caption in place while it fits, otherwise send one fresh panel.
    if (visibleLength(screen.text) <= 1000) {
      try { await ctx.tg.editMessageCaption(m.chat.id, m.message_id, screen.text, { reply_markup: screen.keyboard }); return undefined; } catch { /* fall through: send a fresh panel */ }
    }
    await ctx.tg.sendMessage(m.chat.id, screen.text, { reply_markup: screen.keyboard });
    return undefined;
  }
  await safeEdit(ctx, m.chat.id, m.message_id, screen.text, { reply_markup: screen.keyboard });
  return undefined;
}
