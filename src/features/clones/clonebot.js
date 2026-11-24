// Clone bots for users: /clonebot (create), /myclone (manage your own clone), /clone (inside a clone: opens the main bot).
// Creation steps are private messages kept in pending actions: the BotFather token (60 seconds), then the Turso
// database URL and token. Nothing is announced as done until it actually succeeded.
import { createPending, deletePendingForUser, getPendingForUser, takePending } from '../../database/state.js';
import { btn, markup, urlBtn, backCloseRow } from '../../keyboards/inlineKeyboard.js';
import { blockquote, box, row } from '../../ui/design.js';
import { esc, messages } from '../../utils/formatter.js';
import { reply } from '../../handlers/helpers.js';
import { recordError } from '../../core/errorHandler.js';
import { developerLink } from '../../core/config.js';
import { cloneKeyReady, encryptSecret, decryptSecret, newWebhookSecret } from '../../core/cloneCrypto.js';
import { cloneLimit, countOwnerClones, botIdTaken, dbUrlTaken, getClone, getCloneSecrets, insertClone, listClones, logCloneNotification, updateClone } from '../../database/clones.js';
import { getBotSetting, setBotSetting } from '../../database/settings.js';
import { isOn } from '../roles/controls.js';
import { addSudoUser, isSudoUser, listSudoUsers, removeSudoUser, logAudit } from '../../database/roles.js';
import { isBotOwner } from '../../core/permissions.js';
import { createDb } from '../../database/turso.js';
import { runMigrations, initDefaultSettings } from '../../database/migrations.js';
import { Telegram } from '../../services/telegram.js';
import { nowSec } from '../../utils/helpers.js';
import { deleteCloneWebhook, safeError, setAndVerifyCloneWebhook, verifyCloneWebhook } from './webhook.js';
import { seedCloneBans } from './gbanSync.js';

const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
const TOKEN_TTL = 60;   // spec: the BotFather token must be sent within 1 minute
const STEP_TTL = 300;

export const TURSO_GUIDE = [
  '📘 <b>How to create your Turso database</b>',
  '',
  '1. Create a free account at turso.tech.',
  '2. Install the Turso CLI from the official Turso website or docs.',
  '3. Log in: <code>turso auth login</code>',
  '4. Create a database: <code>turso db create my-clone-bot</code> (any name you like).',
  '5. Copy the URL: <code>turso db show --url my-clone-bot</code> (it starts with libsql://).',
  '6. Create a token: <code>turso db tokens create my-clone-bot</code>',
  '7. Send the URL and the token to this bot when it asks.',
  '',
  '🔒 Keep the token private. Never share it with anyone, and never post it in a group.',
].join('\n');

const dbFor = (ctx, url, token) => (ctx.cloneDbFactory ? ctx.cloneDbFactory(url, token) : createDb({ turso: { url, token } }));

/** Opens a clone's own database from its stored (encrypted) row. */
export async function openCloneDb(ctx, row) {
  return dbFor(ctx, row.db_url, await decryptSecret(ctx.config.cloneKey, row.db_token_enc));
}

const STATUS_LABEL = {
  running: '🟢 Running',
  stopped: '🔴 Stopped',
  webhook_failed: '🟠 Webhook Not Set',
  db_deleted: '⚪ Database deleted',
};

/** Sends a clone owner a DM from the main bot and records the delivery result. Never throws. */
export async function notifyCloneOwner(ctx, clone, kind, emoji, title, lines, keyboard = null) {
  const text = `${box(emoji, title)}\n\n${blockquote(lines.join('\n'))}`;
  let ok = true;
  let error = null;
  try {
    await ctx.tg.sendMessage(Number(clone.owner_user_id), text, keyboard ? { reply_markup: keyboard } : {});
  } catch (e) {
    ok = false;
    error = safeError(e?.message);
  }
  await logCloneNotification(ctx.db, { cloneId: clone.id, ownerId: clone.owner_user_id, kind, ok, error }).catch(() => {});
  return ok;
}

async function mainUsername(ctx) {
  return (await ctx.botInfo()).username || '';
}

// ---------------------------------------------------------------- /clonebot (create)

export async function clonebotCommand(ctx, msg) {
  if (ctx.clone) return reply(ctx, msg, messages.warning('Not Here', 'Clone bots are created with the main bot. Use /clone to open it.'));
  const uid = msg.from.id;
  if (!(await isOn(ctx.db, 'cloning_enabled'))) {
    const dev = developerLink(ctx.config);
    const support = dev ? [[urlBtn('💬 Owner (support)', dev, { style: 'primary' })]] : [];
    return reply(ctx, msg, `${box('🧬', 'Cloning Is Stopped')}\n\n${blockquote('New clone bots cannot be created right now. Existing clone bots are not affected.')}`, { reply_markup: markup(support) });
  }
  if (!cloneKeyReady(ctx.config.cloneKey)) return reply(ctx, msg, messages.warning('Not Set Up', 'Cloning is not set up yet. The owner must set CLONE_ENCRYPTION_KEY.'));
  if ((await countOwnerClones(ctx.db, uid)) >= (await cloneLimit(ctx.db))) {
    return reply(ctx, msg, messages.warning('Limit Reached', 'You already have the maximum number of clone bots allowed. Remove one with /myclone to create another.'));
  }
  await deletePendingForUser(ctx.db, 'clone_token', uid);
  await createPending(ctx.db, { kind: 'clone_token', userId: uid, chatId: msg.chat.id, payload: {}, ttlSec: TOKEN_TTL });
  const lines = [
    '1. Open @BotFather and send /newbot (or /token for an existing bot).',
    '2. Copy the token BotFather gives you.',
    '3. Send that token here within 1 minute.',
    '',
    '🔒 The token is stored encrypted and is never shown again.',
  ];
  return reply(ctx, msg, `${box('🧬', 'Create Your Clone Bot')}\n\n${blockquote(lines.join('\n'))}`, {
    reply_markup: markup([[btn('❓ How to create Turso DB', 'cl:h', { style: 'primary' })]]),
  });
}

/** Private messages while a creation step is waiting. Returns true when the message was used. */
export async function cloneStepMessage(ctx, msg) {
  if (typeof msg.text !== 'string' || msg.text.startsWith('/')) return false;
  const uid = msg.from.id;
  const tokenStep = await getPendingForUser(ctx.db, 'clone_token', uid);
  if (tokenStep) return handleToken(ctx, msg, tokenStep);
  const sudoStep = await getPendingForUser(ctx.db, 'clone_sudo', uid);
  if (sudoStep) return handleSudoAdd(ctx, msg, sudoStep);
  const urlStep = await getPendingForUser(ctx.db, 'clone_dburl', uid);
  if (urlStep) return handleDbUrl(ctx, msg, urlStep);
  const tokStep = await getPendingForUser(ctx.db, 'clone_dbtoken', uid);
  if (tokStep) return handleDbToken(ctx, msg, tokStep);
  return false;
}

async function handleToken(ctx, msg, pending) {
  const token = msg.text.trim();
  if (!TOKEN_RE.test(token)) { await reply(ctx, msg, messages.warning('Not A Token', 'That does not look like a BotFather token. Send it again (it looks like 123456:ABC…).')); return true; }
  let me;
  try { me = await new Telegram(token).getMe(); } catch (e) {
    await reply(ctx, msg, messages.warning('Token Rejected', `Telegram did not accept this token. ${esc(safeError(e?.message))}`));
    return true;
  }
  if (!me?.id || !me.is_bot) { await reply(ctx, msg, messages.warning('Token Rejected', 'Telegram did not return a bot for this token.')); return true; }
  const main = await ctx.botInfo();
  if (Number(me.id) === Number(main.id) || (await botIdTaken(ctx.db, me.id))) {
    await reply(ctx, msg, messages.warning('Already Used', 'This bot cannot be used: it is the main bot or it is already a clone.'));
    return true;
  }
  await takePending(ctx.db, pending.id, 'clone_token');
  const tokenEnc = await encryptSecret(ctx.config.cloneKey, token);
  await createPending(ctx.db, {
    kind: 'clone_dburl', userId: msg.from.id, chatId: msg.chat.id, ttlSec: STEP_TTL,
    payload: { botId: me.id, username: me.username || '', name: me.first_name || 'Clone', tokenEnc },
  });
  await ctx.tg.call('deleteMessage', { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});
  await reply(ctx, msg, `${box('✅', 'Bot Verified')}\n\n${blockquote(`🤖 ${esc(me.first_name || 'Clone')} ${me.username ? `(@${esc(me.username)})` : ''}\n\nNow send the Turso database URL (starts with libsql://).`)}`, {
    reply_markup: markup([[btn('❓ How to create Turso DB', 'cl:h', { style: 'primary' })]]),
  });
  return true;
}

async function handleDbUrl(ctx, msg, pending) {
  const url = msg.text.trim();
  if (!/^(libsql|https|wss):\/\/[A-Za-z0-9.-]+/.test(url)) { await reply(ctx, msg, messages.warning('Not A Database URL', 'Send the database URL that starts with libsql:// (from turso db show --url).')); return true; }
  if (await dbUrlTaken(ctx.db, url)) { await reply(ctx, msg, messages.warning('Already Used', 'This database is already used by another clone bot.')); return true; }
  await takePending(ctx.db, pending.id, 'clone_dburl');
  await createPending(ctx.db, { kind: 'clone_dbtoken', userId: msg.from.id, chatId: msg.chat.id, ttlSec: STEP_TTL, payload: { ...pending.payload, dbUrl: url } });
  await reply(ctx, msg, `${box('🔑', 'Database Token')}\n\n${blockquote('Now send the database auth token (from turso db tokens create). It is stored encrypted.')}`);
  return true;
}

async function handleDbToken(ctx, msg, pending) {
  const dbToken = msg.text.trim();
  const p = pending.payload;
  if (dbToken.length < 20) { await reply(ctx, msg, messages.warning('Not A Token', 'That does not look like a database token. Send it again.')); return true; }
  // 1. the database must answer, and it must be empty of other bots' data before it is set up
  let db;
  try {
    db = dbFor(ctx, p.dbUrl, dbToken);
    if (!(await db.ping())) throw new Error('the database did not answer');
  } catch (e) {
    await reply(ctx, msg, messages.warning('Database Not Reachable', `Could not connect to this database. ${esc(safeError(e?.message))}`));
    return true;
  }
  // 2. set up the schema and default settings in THAT database only
  try {
    await runMigrations(db);
    await initDefaultSettings(db, {});
    await setBotSetting(db, 'main_username', await mainUsername(ctx));
    await seedCloneBans(ctx.db, db);
  } catch (e) {
    await recordError(ctx, 'clone setup', e);
    await reply(ctx, msg, messages.warning('Setup Failed', 'The database could not be set up. Check that it is empty and the token has full access.'));
    return true;
  }
  // 3. store the clone (secrets encrypted) and switch its webhook on
  const secret = newWebhookSecret();
  const id = await insertClone(ctx.db, {
    owner_user_id: msg.from.id, bot_id: p.botId, bot_username: p.username, bot_name: p.name,
    token_enc: p.tokenEnc, db_url: p.dbUrl, db_token_enc: await encryptSecret(ctx.config.cloneKey, dbToken),
    webhook_secret_enc: await encryptSecret(ctx.config.cloneKey, secret),
  });
  const token = await decryptSecret(ctx.config.cloneKey, p.tokenEnc);
  const hook = await setAndVerifyCloneWebhook(ctx, id, token, secret);
  await takePending(ctx.db, pending.id, 'clone_dbtoken');
  if (!hook.ok) {
    await updateClone(ctx.db, id, { status: 'webhook_failed', last_error: hook.error, webhook_fail_count: 1 });
    const clone = await getClone(ctx.db, id);
    await notifyCloneOwner(ctx, clone, 'created', '⚠️', 'Clone Created, Webhook Not Set', [
      `🤖 ${esc(p.name)} ${p.username ? `(@${esc(p.username)})` : ''}`,
      `🔗 Webhook: Not Set`,
      `❌ ${esc(hook.error)}`,
      '👉 Use the button below to set up the webhook again.',
    ], markup([[urlBtn('🔗 Set up webhook', `https://t.me/${await mainUsername(ctx)}?start=clonewh_${id}`, { style: 'primary' })]]));
    await reply(ctx, msg, messages.warning('Webhook Not Set', `Your clone was saved, but its webhook could not be set. ${esc(hook.error)}`));
    return true;
  }
  await updateClone(ctx.db, id, { status: 'running', webhook_fail_count: 0, last_error: null });
  // bio of the clone: "Cloned From: @MAIN" (best effort; Telegram limits apply)
  const tg = new Telegram(token);
  const main = await mainUsername(ctx);
  await tg.call('setMyShortDescription', { short_description: `Cloned From: @${main}` }).catch(() => {});
  await tg.call('setMyDescription', { description: `Cloned From: @${main}. Make your own clone bot with /clonebot.` }).catch(() => {});
  const clone = await getClone(ctx.db, id);
  await notifyCloneOwner(ctx, clone, 'created', '🎉', 'Clone Bot Created', [
    `🤖 ${esc(p.name)} ${p.username ? `(@${esc(p.username)})` : ''}`,
    '✅ Creation: Done',
    '🔗 Webhook: Active',
    '🛠 Manage it with /myclone',
  ]);
  await reply(ctx, msg, `${box('🎉', 'Clone Bot Created')}\n\n${blockquote(`🤖 ${esc(p.name)} ${p.username ? `(@${esc(p.username)})` : ''}\n🔗 Webhook: Active\n\nManage it with /myclone.`)}`);
  return true;
}

// ---------------------------------------------------------------- /myclone (owner's panel for their clone)

function detailText(clone) {
  const label = clone.status === 'running' && clone.maintenance ? '🛠 Maintenance (clone)' : STATUS_LABEL[clone.status] || clone.status;
  return `${box('🤖', esc(clone.bot_name))}\n\n${blockquote([
    `👤 Username: ${clone.bot_username ? `@${esc(clone.bot_username)}` : '—'}`,
    `📶 Status: ${label}`,
    `🔗 Webhook: ${clone.status === 'running' ? 'Active' : 'Not Set'}`,
    clone.stopped_by && clone.stopped_by !== 'none' ? `⏹ Stopped by: ${clone.stopped_by === 'main' ? 'Main Owner' : 'you'}` : null,
    clone.last_error && clone.status !== 'running' ? `❌ Last error: ${esc(clone.last_error)}` : null,
  ].filter(Boolean).join('\n'))}`;
}

function detailKeyboard(clone, mainUser) {
  const rows = [];
  if (clone.status === 'stopped') rows.push([btn('▶️ Resume', `cl:r:${clone.id}`, { style: 'success' })]);
  else if (clone.status === 'webhook_failed' || clone.status === 'db_deleted') rows.push([btn('🔁 Restart', `cl:r:${clone.id}`, { style: 'success' })]);
  else rows.push([btn('⏹ Stop', `cl:s:${clone.id}`, { style: 'danger' }), btn('🔁 Restart', `cl:r:${clone.id}`, { style: 'primary' })]);
  rows.push([btn('👥 Users, groups & moderators', `cl:u:${clone.id}`, { style: 'primary' })]);
  rows.push([btn(clone.maintenance ? '🛠 Maintenance: ON' : '🛠 Maintenance: OFF', `cl:m:${clone.id}`, { style: clone.maintenance ? 'danger' : 'primary' })]);
  rows.push([btn('♻️ Reset data', `cl:x:${clone.id}`, { style: 'danger' }), btn('🗑 Delete database', `cl:D:${clone.id}`, { style: 'danger' })]);
  rows.push([btn('🗑 Remove clone', `cl:R:${clone.id}`, { style: 'danger' })]);
  rows.push([btn('💬 Message Owner', `ur:${mainUser}`, { style: 'primary' })]);
  rows.push(backCloseRow('cl:list'));
  return markup(rows);
}

export async function myCloneCommand(ctx, msg) {
  if (ctx.clone) return reply(ctx, msg, messages.warning('Not Here', 'Use /clone to open the main bot.'));
  const list = await listClones(ctx.db, msg.from.id);
  if (!list.length) return reply(ctx, msg, `${box('🤖', 'My Clone Bots')}\n\n${blockquote('You do not have a clone bot yet. Create one with /clonebot.')}`);
  const rows = list.map((c) => [btn(`🤖 ${c.bot_name.slice(0, 20)} · ${STATUS_LABEL[c.status] || c.status}`, `cl:v:${c.id}`, { style: c.status === 'running' ? 'success' : 'primary' })]);
  return reply(ctx, msg, `${box('🤖', 'My Clone Bots')}\n\n${blockquote(`You have ${list.length} clone bot(s).`)}`, { reply_markup: markup(rows) });
}

/** The clone's own button: opens the main bot with the clone creation flow. */
export async function cloneLinkCommand(ctx, msg) {
  const target = ctx.clone ? await getBotSetting(ctx.db, 'main_username', '') : await mainUsername(ctx);
  if (!target) return reply(ctx, msg, messages.warning('Not Available', 'The main bot link is not known yet.'));
  return reply(ctx, msg, `${box('🧬', 'Make Your Own Clone Bot')}\n\n${blockquote('Open the main bot and send /clonebot.')}`, {
    reply_markup: markup([[urlBtn('🧬 Make Your Clone Bot', `https://t.me/${target}?start=clonebot`, { style: 'primary' })]]),
  });
}

// ---------------------------------------------------------------- owner actions (cl:*)

async function ownsClone(ctx, cq, clone) {
  return clone && (Number(clone.owner_user_id) === Number(cq.from.id) || isBotOwner(ctx.config, cq.from.id));
}

/** Clone owner or moderator asks the Main Owner for broadcast permission. The request reaches the Main Owner's DM via the main bot. */
async function requestCloneBroadcast(ctx, cq) {
  if (!ctx.clone) return ctx.tg.answerCallbackQuery(cq.id, 'This works only inside a clone bot.', true);
  const isCloneOwner = Number(cq.from.id) === ctx.clone.ownerId;
  if (!isCloneOwner && !(await isSudoUser(ctx.db, cq.from.id).catch(() => false))) {
    return ctx.tg.answerCallbackQuery(cq.id, 'Only the clone owner or its moderators can ask.', true);
  }
  if (ctx.clone.broadcastApproved) return ctx.tg.answerCallbackQuery(cq.id, 'Broadcast is already approved.', false);
  const last = Number(await getBotSetting(ctx.db, 'broadcast_request_at', '0'));
  if (nowSec() - last < 3600) return ctx.tg.answerCallbackQuery(cq.id, 'A request was already sent. Try again later.', true);
  if (!ctx.mainTg || !ctx.config.mainOwnerId) return ctx.tg.answerCallbackQuery(cq.id, 'The Main Owner cannot be reached right now.', true);
  const who = cq.from.username ? `@${esc(cq.from.username)}` : `<code>${Number(cq.from.id)}</code>`;
  const text = `${box('📣', 'Broadcast Permission Request')}\n\n${blockquote(`🤖 ${esc(ctx.config.botName)}\n👤 Requested by: ${who}\n\nAccept or deny below. An accepted clone can broadcast (text messages).`)}`;
  try {
    await ctx.mainTg.sendMessage(ctx.config.mainOwnerId, text, { reply_markup: markup([[btn('✅ Accept', `cm:ba:${ctx.clone.id}`, { style: 'success' }), btn('❌ Deny', `cm:bd:${ctx.clone.id}`, { style: 'danger' })]]) });
  } catch {
    return ctx.tg.answerCallbackQuery(cq.id, 'The request could not be delivered. Try again later.', true);
  }
  await setBotSetting(ctx.db, 'broadcast_request_at', String(nowSec()));
  return ctx.tg.answerCallbackQuery(cq.id, 'Request sent to the Main Owner.', false);
}

async function safeCount(db, table) {
  try { return String(Number((await db.value(`SELECT COUNT(*) FROM ${table}`, [], 0)) || 0)); } catch { return '—'; }
}

/** Users, groups and moderators of one clone, read from that clone's own database. */
async function cloneUsersScreen(ctx, id, row) {
  const cloneDb = await openCloneDb(ctx, row);
  const mods = (await listSudoUsers(cloneDb)).slice(0, 10);
  const { usageOf, usageLines } = await import('./usage.js');
  const usage = await usageOf(cloneDb, undefined, { heal: true });
  const text = `${box('👥', 'Users & Moderators')}\n\n${blockquote([
    `👤 Users: ${await safeCount(cloneDb, 'users')}`,
    `🏘 Groups: ${await safeCount(cloneDb, 'groups')}`,
    `🛡 Moderators: ${mods.length}${mods.length === 10 ? '+' : ''}`,
    ...usageLines(usage).map((l) => `📈 ${l}`),
    ...mods.map((m) => `• <code>${Number(m.user_id)}</code>`),
  ].join('\n'))}`;
  const rows = mods.map((m) => [btn(`➖ Remove ${Number(m.user_id)}`, `cl:sr:${id}:${Number(m.user_id)}`, { style: 'danger' })]);
  rows.push([btn('➕ Add moderator', `cl:sa:${id}`, { style: 'success' })]);
  rows.push([btn('◀️ Back', `cl:v:${id}`, { style: 'primary' })]);
  return { text, keyboard: markup(rows) };
}

/** The owner sends a user id in private: it becomes a moderator of that clone only. */
async function handleSudoAdd(ctx, msg, pending) {
  const target = Number(String(msg.text || '').trim());
  if (!Number.isInteger(target) || target <= 0) {
    await reply(ctx, msg, messages.warning('Not A User ID', 'Send the numeric Telegram user id of the moderator.'));
    return true;
  }
  const row = await getCloneSecrets(ctx.db, pending.payload.cloneId);
  if (!row || row.status === 'removed' || Number(row.owner_user_id) !== msg.from.id) {
    await takePending(ctx.db, pending.id, 'clone_sudo');
    await reply(ctx, msg, messages.warning('Not Available', 'This clone is not available to you.'));
    return true;
  }
  const cloneDb = await openCloneDb(ctx, row);
  await addSudoUser(cloneDb, target, msg.from.id);
  await logAudit(cloneDb, { actor: msg.from.id, action: 'clone_sudo_add', target });
  await takePending(ctx.db, pending.id, 'clone_sudo');
  await reply(ctx, msg, `${box('✅', 'Moderator Added')}\n\n${blockquote(`🛡 <code>${target}</code> can now use the commands of your clone bot.`)}`);
  return true;
}

export async function cloneCallback(ctx, cq, parts) {
  const action = parts[1];
  if (action === 'h') {
    await ctx.tg.sendMessage(cq.from.id, TURSO_GUIDE);
    return ctx.tg.answerCallbackQuery(cq.id, 'Guide sent in your DM.', false);
  }
  if (action === 'bq') return requestCloneBroadcast(ctx, cq);
  if (action === 'list') return myCloneCommandCallback(ctx, cq);
  const id = Number(parts[2]);
  const row = await getCloneSecrets(ctx.db, id);
  if (!row || row.status === 'removed' || !(await ownsClone(ctx, cq, row))) return ctx.tg.answerCallbackQuery(cq.id, 'This clone is not available to you.', true);
  if (row.stopped_by === 'main' && !isBotOwner(ctx.config, cq.from.id)) return ctx.tg.answerCallbackQuery(cq.id, 'This clone was stopped by the Main Owner.', true);
  const clone = await getClone(ctx.db, id);
  const token = row.token_enc ? await decryptSecret(ctx.config.cloneKey, row.token_enc) : null;
  const edit = (text, keyboard) => ctx.tg.editMessageText(cq.message.chat.id, cq.message.message_id, text, { reply_markup: keyboard }).catch(() => {});
  const show = async (toast) => { await edit(detailText(await getClone(ctx.db, id)), detailKeyboard(await getClone(ctx.db, id), ctx.config.ownerId)); return ctx.tg.answerCallbackQuery(cq.id, toast || '', false); };

  switch (action) {
    case 'v': return show();
    case 'u': {
      const screen = await cloneUsersScreen(ctx, id, row);
      await ctx.tg.editMessageText(cq.message.chat.id, cq.message.message_id, screen.text, { reply_markup: screen.keyboard }).catch(() => {});
      return ctx.tg.answerCallbackQuery(cq.id, '', false);
    }
    case 'sa': {
      await deletePendingForUser(ctx.db, 'clone_sudo', cq.from.id);
      await createPending(ctx.db, { kind: 'clone_sudo', userId: cq.from.id, chatId: cq.message.chat.id, payload: { cloneId: id }, ttlSec: 600 });
      await ctx.tg.editMessageText(cq.message.chat.id, cq.message.message_id, `${box('➕', 'Add Moderator')}\n\n${blockquote('Send the numeric Telegram user id of the person. They become a moderator of this clone only.')}`, { reply_markup: markup([[btn('❌ Cancel', `cl:u:${id}`, { style: 'danger' })]]) }).catch(() => {});
      return ctx.tg.answerCallbackQuery(cq.id, 'Send the user id in this chat.', false);
    }
    case 'sr': {
      const uid = Number(parts[3]);
      const cloneDb = await openCloneDb(ctx, row);
      await removeSudoUser(cloneDb, uid);
      await logAudit(cloneDb, { actor: cq.from.id, action: 'clone_sudo_remove', target: uid });
      const screen = await cloneUsersScreen(ctx, id, row);
      await ctx.tg.editMessageText(cq.message.chat.id, cq.message.message_id, screen.text, { reply_markup: screen.keyboard }).catch(() => {});
      return ctx.tg.answerCallbackQuery(cq.id, 'Moderator removed.', false);
    }
    case 'm': {
      await updateClone(ctx.db, id, { maintenance: row.maintenance ? 0 : 1 });
      return show(row.maintenance ? 'Maintenance is OFF for this clone.' : 'Maintenance is ON for this clone.');
    }
    case 's': {
      await deleteCloneWebhook(token);
      await updateClone(ctx.db, id, { status: 'stopped', stopped_by: 'owner' });
      await notifyCloneOwner(ctx, await getClone(ctx.db, id), 'stopped', '⏹', 'Clone Bot Stopped', [`🤖 ${esc(clone.bot_name)}`, '⏹ Stopped by: you', '▶️ Resume any time from /myclone']);
      return show('Stopped.');
    }
    case 'r': {
      if (row.status === 'db_deleted') {
        const db = dbFor(ctx, row.db_url, await decryptSecret(ctx.config.cloneKey, row.db_token_enc));
        await runMigrations(db);
        await initDefaultSettings(db, {});
      }
      const hook = await setAndVerifyCloneWebhook(ctx, id, token, await decryptSecret(ctx.config.cloneKey, row.webhook_secret_enc));
      if (!hook.ok) {
        await updateClone(ctx.db, id, { status: 'webhook_failed', last_error: hook.error });
        await notifyCloneOwner(ctx, await getClone(ctx.db, id), 'webhook_failed', '⚠️', 'Webhook Failed', [`🤖 ${esc(clone.bot_name)}`, `❌ ${esc(hook.error)}`], markup([[urlBtn('🔗 Set up webhook', `https://t.me/${await mainUsername(ctx)}?start=clonewh_${id}`, { style: 'primary' })]]));
        return show('The webhook could not be set. See the error.');
      }
      await updateClone(ctx.db, id, { status: 'running', stopped_by: 'none', webhook_fail_count: 0, last_error: null });
      const wasStopped = row.status === 'stopped';
      await notifyCloneOwner(ctx, await getClone(ctx.db, id), wasStopped ? 'started' : 'restarted', wasStopped ? '▶️' : '🔁', wasStopped ? 'Clone Bot Started' : 'Clone Bot Restarted', [`🤖 ${esc(clone.bot_name)}`, '🟢 Running', '🔗 Webhook: Active']);
      return show('Restarted.');
    }
    case 'x': return confirm(ctx, cq, id, 'reset', '♻️ Reset data?', 'All data of this clone (users, groups, settings, logs) is erased. The bot and its database stay.');
    case 'xy': {
      const db = dbFor(ctx, row.db_url, await decryptSecret(ctx.config.cloneKey, row.db_token_enc));
      const tables = (await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'")).map((t) => t.name);
      for (const t of tables) await db.execute(`DELETE FROM "${t.replace(/"/g, '""')}"`);
      await initDefaultSettings(db, {});
      await setBotSetting(db, 'main_username', await mainUsername(ctx));
      await notifyCloneOwner(ctx, clone, 'reset', '♻️', 'Clone Bot Reset', [`🤖 ${esc(clone.bot_name)}`, `✅ Cleared ${tables.length} data table(s)`, '⚙️ Default settings restored']);
      return show('Reset done.');
    }
    case 'D': return confirm(ctx, cq, id, 'deletedb', '🗑 Delete database?', 'Every table of this clone database is dropped and the clone stops. This cannot be undone.');
    case 'Dy': {
      await deleteCloneWebhook(token);
      const db = dbFor(ctx, row.db_url, await decryptSecret(ctx.config.cloneKey, row.db_token_enc));
      const tables = (await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")).map((t) => t.name);
      for (const t of tables) await db.execute(`DROP TABLE IF EXISTS "${t.replace(/"/g, '""')}"`);
      await updateClone(ctx.db, id, { status: 'db_deleted', stopped_by: 'owner' });
      await notifyCloneOwner(ctx, await getClone(ctx.db, id), 'db_deleted', '🗑', 'Database Deleted', [`🤖 ${esc(clone.bot_name)}`, `✅ Dropped ${tables.length} table(s)`, '🔁 Restart from /myclone to set the database up again']);
      return show('Database deleted.');
    }
    case 'R': return confirm(ctx, cq, id, 'remove', '🗑 Remove clone?', 'The clone is switched off and its token is removed from this system. Its database is not deleted.');
    case 'Ry': {
      await deleteCloneWebhook(token);
      await updateClone(ctx.db, id, { status: 'removed', removed_at: nowSec(), stopped_by: 'owner', last_error: null });
      await ctx.db.execute('UPDATE clones SET token_enc = NULL, webhook_secret_enc = NULL WHERE id = ?', [id]);
      await notifyCloneOwner(ctx, clone, 'removed', '🗑', 'Clone Bot Removed', [`🤖 ${esc(clone.bot_name)}`, '✅ Switched off and removed from this system']);
      await ctx.tg.editMessageText(cq.message.chat.id, cq.message.message_id, `${box('🗑', 'Clone Removed')}`).catch(() => {});
      return ctx.tg.answerCallbackQuery(cq.id, 'Removed.', false);
    }
    case 'c': return ctx.tg.answerCallbackQuery(cq.id, 'Cancelled.', false).then(() => show());
    default: return ctx.tg.answerCallbackQuery(cq.id, 'Unknown button.', true);
  }
}

async function confirm(ctx, cq, id, what, title, body) {
  const yes = { reset: `cl:xy:${id}`, deletedb: `cl:Dy:${id}`, remove: `cl:Ry:${id}` }[what];
  await ctx.tg.editMessageText(cq.message.chat.id, cq.message.message_id, `${box('⚠️', title)}\n\n${blockquote(body)}`, {
    reply_markup: markup([[btn('✅ Yes, do it', yes, { style: 'danger' }), btn('Cancel', `cl:c:${id}`, { style: 'primary' })]]),
  }).catch(() => {});
  return ctx.tg.answerCallbackQuery(cq.id, 'Please confirm.', false);
}

async function myCloneCommandCallback(ctx, cq) {
  const list = await listClones(ctx.db, cq.from.id);
  const rows = list.map((c) => [btn(`🤖 ${c.bot_name.slice(0, 20)} · ${STATUS_LABEL[c.status] || c.status}`, `cl:v:${c.id}`, { style: c.status === 'running' ? 'success' : 'primary' })]);
  await ctx.tg.editMessageText(cq.message.chat.id, cq.message.message_id, `${box('🤖', 'My Clone Bots')}\n\n${blockquote(`You have ${list.length} clone bot(s).`)}`, { reply_markup: markup(rows) }).catch(() => {});
  return ctx.tg.answerCallbackQuery(cq.id, '', false);
}

/** Deep link https://t.me/<main>?start=clonewh_<id>: the owner sets the webhook of that clone, and the result is shown. */
export async function cloneWebhookStart(ctx, msg, idText) {
  const id = Number(idText);
  const row = await getCloneSecrets(ctx.db, id);
  if (!row || row.status === 'removed' || !row.token_enc || !(Number(row.owner_user_id) === msg.from.id || isBotOwner(ctx.config, msg.from.id))) {
    return reply(ctx, msg, messages.warning('Not Available', 'This webhook link is not valid for you.'));
  }
  if (row.stopped_by === 'main' && !isBotOwner(ctx.config, msg.from.id)) return reply(ctx, msg, messages.warning('Stopped', 'This clone was stopped by the Main Owner.'));
  const token = await decryptSecret(ctx.config.cloneKey, row.token_enc);
  const hook = await setAndVerifyCloneWebhook(ctx, id, token, await decryptSecret(ctx.config.cloneKey, row.webhook_secret_enc));
  if (!hook.ok) {
    await updateClone(ctx.db, id, { status: 'webhook_failed', last_error: hook.error });
    return reply(ctx, msg, messages.warning('Webhook Not Set', `Telegram did not confirm the webhook. ${esc(hook.error)}`));
  }
  await updateClone(ctx.db, id, { status: 'running', stopped_by: 'none', webhook_fail_count: 0, last_error: null });
  await notifyCloneOwner(ctx, await getClone(ctx.db, id), 'webhook_ok', '🔗', 'Webhook Active', [`🤖 ${esc(row.bot_name)}`, '✅ Telegram confirmed the webhook']);
  return reply(ctx, msg, box('🔗', 'Webhook Active'));
}

export async function verifyForHealth(token, url) {
  return verifyCloneWebhook(token, url);
}

export { nowSec, cloneKeyReady, isOn, STEP_TTL };
