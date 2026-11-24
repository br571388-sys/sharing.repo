import test from 'node:test';
import assert from 'node:assert/strict';
import { processUpdate } from '../src/core/webhook.js';
import { handleRequest } from '../src/index.js';
import { runGroupCron } from '../src/features/groupmgmt/groupCron.js';
import { addSudoUser, getGlobalBan, isGloballyBanned, resultSummary, isSudoUser } from '../src/database/roles.js';
import { menuCommands } from '../src/handlers/commands.js';
import { developerLink, loadConfig } from '../src/core/config.js';
import { BOT_ID, OWNER, callbackQuery, groupMsg, makeCtx, privateMsg, update } from './helpers/fakes.js';

const norm = (s) => String(s).replace(/<[^>]+>/g, '').normalize('NFKC');
const SUDO = 2000;
const USER = 3000;
const VICTIM = 4242424;
const G = [-9001, -9002, -9003, -9004];

const kb = (call) => (call.params.reply_markup?.inline_keyboard || []).flat();
const kbTexts = (call) => kb(call).map((b) => norm(b.text));
const say = (f, from, text) => processUpdate(f.ctx, update({ message: privateMsg(from, text) }));

async function addGroups(f) {
  for (const id of G) {
    const chat = { id, type: 'supergroup', title: `Group ${id}` };
    await processUpdate(f.ctx, update({ message: { message_id: 1, chat, from: { id: 77 }, new_chat_members: [{ id: BOT_ID, is_bot: true }] } }));
  }
  f.tg.reset();
}
const botAdmin = (f, chat) => f.tg.setMember(chat, BOT_ID, 'administrator', { can_restrict_members: true });

test('/sudo: owner manages sudo moderators; users and sudo users are refused', async () => {
  const f = await makeCtx();
  await say(f, USER, '/sudo add 55555');
  assert.match(f.tg.texts().at(-1), /ACCESS DENIED/i);
  assert.equal(await isSudoUser(f.db, 55555), false);

  await say(f, OWNER, '/sudo add 55555');
  assert.equal(await isSudoUser(f.db, 55555), true);
  assert.match(f.tg.texts().at(-1) , /SUDO MODERATOR ADDED/i);
  await say(f, OWNER, '/sudo add 55555');
  assert.match(f.tg.texts().at(-1), /ALREADY SUDO/i);
  await say(f, OWNER, '/sudo add abc');
  assert.match(f.tg.texts().at(-1), /INVALID USER ID/i);
  await say(f, OWNER, `/sudo add ${OWNER}`);
  assert.match(f.tg.texts().at(-1), /ALREADY THE OWNER/i);

  await say(f, 55555, '/sudo add 66666');
  assert.equal(await isSudoUser(f.db, 66666), false, 'sudo users cannot add sudo users');

  await say(f, OWNER, '/sudo list');
  assert.match(f.tg.texts().at(-1), /55555/);
  await say(f, OWNER, '/sudo remove 55555');
  assert.equal(await isSudoUser(f.db, 55555), false);
  await say(f, OWNER, '/sudo remove 55555');
  assert.match(f.tg.texts().at(-1), /NOT A SUDO/i);
});

test('role-aware /start: owner, moderator and normal user see different greetings', async () => {
  const f = await makeCtx();
  await addSudoUser(f.db, SUDO, OWNER);
  await say(f, OWNER, '/start');
  assert.match(norm(f.tg.sent('sendMessage').filter((m) => m.params.text !== '🎉').pop().params.text), /WELCOME BOSS!.*Main Owner of Nobara/s);
  await say(f, SUDO, '/start');
  assert.match(norm(f.tg.sent('sendMessage').filter((m) => m.params.text !== '🎉').pop().params.text), /WELCOME MODERATOR!.*Sudo Moderator of Nobara/s);
  await say(f, USER, '/start');
  const t = norm(f.tg.sent('sendMessage').filter((m) => m.params.text !== '🎉').pop().params.text);
  assert.match(t, /WELCOME!/);
  assert.doesNotMatch(t, /Owner|Moderator/);
  assert.ok(kbTexts(f.tg.sent('sendMessage').filter((m) => m.params.text !== '🎉')[0]).includes('🛡 PANEL'));
  assert.ok(!kbTexts(f.tg.sent('sendMessage').filter((m) => m.params.text !== '🎉').pop()).includes('🛡 PANEL'), 'users never get the panel button');
});

test('help is role specific and hidden commands are blocked when typed directly', async () => {
  const f = await makeCtx();
  await addSudoUser(f.db, SUDO, OWNER);
  const sections = async (who) => { f.tg.reset(); await say(f, who, '/help'); return kbTexts(f.tg.last('sendMessage')); };
  const user = await sections(USER);
  assert.ok(!user.includes('🛡 MODERATOR') && !user.includes('👑 OWNER'));
  const sudo = await sections(SUDO);
  assert.ok(sudo.includes('🛡 MODERATOR') && !sudo.includes('👑 OWNER'));
  const owner = await sections(OWNER);
  assert.ok(owner.includes('🛡 MODERATOR') && owner.includes('👑 OWNER'));

  // sudo sees /panel + /gban family but never /sudo
  const msg = { message_id: 9, chat: { id: SUDO, type: 'private' } };
  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(SUDO, msg, 'm:help:mod') }));
  const page = norm(f.tg.last('editMessageText').params.text);
  assert.match(page, /\/gban/i); assert.match(page, /\/panel/i);
  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(SUDO, msg, 'm:help:ownerRoles') }));
  assert.equal(f.tg.last('answerCallbackQuery').params.show_alert, true);

  for (const cmd of ['/panel', '/gban 123456 x', '/ungban 123456', '/gbanlist', '/gbaninfo 123456']) {
    f.tg.reset();
    await say(f, USER, cmd);
    assert.match(f.tg.texts().at(-1), /ACCESS DENIED/i, `${cmd} blocked for users`);
  }
  assert.equal(await isGloballyBanned(f.db, 123456), false);

  const names = (a) => menuCommands(a).map((c) => c.command);
  assert.ok(!names('default').includes('panel') && !names('default').includes('gban') && !names('default').includes('sudo'));
  assert.ok(names('sudo').includes('gban') && !names('sudo').includes('sudo') && !names('sudo').includes('broadcast'));
  assert.ok(names('owner').includes('sudo') && names('owner').includes('panel'));
});

test('/panel shows real statistics, navigates in place and re-checks the role on every tap', async () => {
  const f = await makeCtx();
  await addSudoUser(f.db, SUDO, OWNER);
  await say(f, 11, '/start'); await say(f, 12, '/start');
  await addGroups(f);
  await say(f, 11, '/panel');
  assert.match(f.tg.texts().at(-1), /ACCESS DENIED/i);

  await say(f, SUDO, '/panel');
  const panel = f.tg.last('sendMessage');
  const text = norm(panel.params.text);
  assert.match(text, /Total users: 3/, 'users 11, 12 and the moderator');
  assert.match(text, /Groups: 4 active \/ 4 total/);
  assert.match(text, /Sudo moderators: 1/);
  const labels = kbTexts(panel);
  for (const l of ['👤 USER STATS', '👥 GROUP STATS', '🚫 BANNED USERS', '🕘 RECENT ACTIVITY', '🔄 REFRESH', '❌ CLOSE']) assert.ok(labels.includes(l), l);
  assert.ok(!labels.includes('🛡 SUDO MANAGEMENT'), 'sudo moderators cannot manage sudo');

  const msg = { message_id: 70, chat: { id: SUDO, type: 'private' } };
  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(SUDO, msg, 'pn:g:0') }));
  assert.match(norm(f.tg.last('editMessageText').params.text), /GROUP STATS/);
  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(SUDO, msg, 'pn:sd:0') }));
  assert.equal(f.tg.last('answerCallbackQuery').params.show_alert, true);
  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(USER, msg, 'pn:m') }));
  assert.equal(f.tg.last('answerCallbackQuery').params.show_alert, true, 'a forwarded panel is useless to normal users');
  assert.equal(f.tg.sent('editMessageText').length, 0);

  // owner: sudo management with a confirmed removal
  await say(f, OWNER, '/panel');
  assert.ok(kbTexts(f.tg.last('sendMessage')).includes('🛡 SUDO MANAGEMENT'));
  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(OWNER, msg, 'pn:sd:0') }));
  assert.ok(kbTexts(f.tg.last('editMessageText')).some((t) => t.includes('⚙️')), 'moderator button opens that person');
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(OWNER, msg, `pn:sy:${SUDO}`) }));
  assert.equal(await isSudoUser(f.db, SUDO), false);
});

test('/gban: bans everywhere it can, and reports skipped / failed groups honestly', async () => {
  const f = await makeCtx();
  await addSudoUser(f.db, SUDO, OWNER);
  await addGroups(f);
  botAdmin(f, G[0]); botAdmin(f, G[1]);               // bans work here
  f.tg.setMember(G[2], BOT_ID, 'member');             // no admin rights -> skipped
  botAdmin(f, G[3]); f.tg.setMember(G[3], VICTIM, 'administrator'); // target is admin there -> skipped

  await say(f, USER, `/gban ${VICTIM}`);
  assert.equal(await getGlobalBan(f.db, VICTIM), null);

  await say(f, SUDO, `/gban ${VICTIM} spam raider`);
  const ban = await getGlobalBan(f.db, VICTIM);
  assert.equal(ban.status, 'active'); assert.equal(ban.moderator_id, SUDO); assert.equal(ban.reason, 'spam raider');
  assert.deepEqual(f.tg.sent('banChatMember').map((c) => c.params.chat_id).sort(), [G[0], G[1]].sort());
  const s = await resultSummary(f.db, VICTIM);
  assert.deepEqual([s.ok, s.skipped, s.failed, s.pending], [2, 2, 0, 0]);
  const out = norm(f.tg.last('sendMessage').params.text);
  assert.match(out, /Banned \(confirmed\): 2/); assert.match(out, /Skipped: 2/);
  assert.match(out, /not an administrator/); assert.match(out, /target is an administrator/);

  await say(f, SUDO, `/gban ${VICTIM}`);
  assert.match(f.tg.texts().at(-1), /ALREADY GLOBALLY BANNED/i);
  const replyTo = (id) => privateMsg(SUDO, '/gban', { reply_to_message: { message_id: 1, from: { id, first_name: 'T' }, chat: { id: SUDO, type: 'private' } } });
  await processUpdate(f.ctx, update({ message: replyTo(OWNER) }));
  assert.match(f.tg.texts().at(-1), /NOT ALLOWED/i);
  await processUpdate(f.ctx, update({ message: replyTo(SUDO) }));
  assert.match(f.tg.texts().at(-1), /NOT ALLOWED/i);
  assert.equal(await isGloballyBanned(f.db, OWNER), false);

  await say(f, SUDO, '/gbanlist');
  assert.match(f.tg.texts().at(-1), new RegExp(String(VICTIM)));
  await say(f, SUDO, `/gbaninfo ${VICTIM}`);
  const info = norm(f.tg.texts().at(-1));
  assert.match(info, /Confirmed bans: 2/); assert.match(info, /Globally banned/);
});

test('/gban supports reply, real failures are reported, large lists continue via cron, /ungban lifts', async () => {
  const f = await makeCtx();
  await addGroups(f);
  for (const g of G) botAdmin(f, g);
  f.tg.failWhen((m, p) => m === 'banChatMember' && p.chat_id === G[1], new (await import('../src/utils/errors.js')).TelegramError('Bad Request: not enough rights', { status: 400 }));

  const reply = privateMsg(OWNER, '/gban flooding', { reply_to_message: { message_id: 1, from: { id: VICTIM, first_name: 'V' }, chat: { id: OWNER, type: 'private' } } });
  await processUpdate(f.ctx, update({ message: reply }));
  const s = await resultSummary(f.db, VICTIM);
  assert.equal(s.ok, 3); assert.equal(s.failed, 1);
  assert.match(norm(f.tg.last('sendMessage').params.text), /Failed: 1/);
  assert.doesNotMatch(norm(f.tg.last('sendMessage').params.text), /all groups/i);

  // queue larger than one batch: the cron finishes it
  const f2 = await makeCtx();
  for (let i = 0; i < 45; i++) await f2.db.execute("INSERT INTO groups (telegram_chat_id, title, group_type, is_active, joined_at, updated_at) VALUES (?, 'g', 'supergroup', 1, 1, 1)", [-5000 - i]);
  for (let i = 0; i < 45; i++) botAdmin(f2, -5000 - i);
  await say(f2, OWNER, `/gban ${VICTIM} big`);
  let sum = await resultSummary(f2.db, VICTIM);
  assert.equal(sum.ok, 20); assert.equal(sum.pending, 25);
  assert.match(norm(f2.tg.last('sendMessage').params.text), /Still queued: 25/);
  await runGroupCron(f2.ctx, new Date());
  await runGroupCron(f2.ctx, new Date());
  sum = await resultSummary(f2.db, VICTIM);
  assert.equal(sum.ok, 45); assert.equal(sum.pending, 0);

  await say(f2, OWNER, `/ungban ${VICTIM}`);
  assert.equal(await isGloballyBanned(f2.db, VICTIM), false);
  assert.equal(f2.tg.sent('unbanChatMember').length, 20 + 0, 'first batch');
  await runGroupCron(f2.ctx, new Date()); await runGroupCron(f2.ctx, new Date());
  assert.equal((await resultSummary(f2.db, VICTIM)).lifted, 45);
  await say(f2, OWNER, `/ungban ${VICTIM}`);
  assert.match(f2.tg.texts().at(-1), /NOT GLOBALLY BANNED/i);
});

test('globally banned users are removed when they join, and groups added later get the ban queued', async () => {
  const f = await makeCtx();
  await say(f, OWNER, `/gban ${VICTIM} known spammer`);
  await addGroups(f);
  assert.equal((await f.db.value("SELECT COUNT(*) FROM global_ban_results WHERE user_id = ? AND status = 'pending'", [VICTIM])), 4, 'queued for every new group');
  botAdmin(f, G[0]);
  const chat = { id: G[0], type: 'supergroup', title: 'Group' };
  await processUpdate(f.ctx, update({ message: { message_id: 5, chat, from: { id: VICTIM }, new_chat_members: [{ id: VICTIM, first_name: 'V', is_bot: false }] } }));
  assert.equal(f.tg.sent('banChatMember').at(-1).params.user_id, VICTIM);
  assert.equal(f.tg.sent('banChatMember').at(-1).params.chat_id, G[0]);
});

test('Developer button opens the profile via tg://user?id= from DEVELOPER_ID; hidden when unset', async () => {
  const f = await makeCtx({ env: { DEVELOPER_ID: '777001', DEVELOPER_URL: 'https://t.me/dev' } });
  await say(f, USER, '/start');
  const dev = kb(f.tg.last('sendMessage')).find((b) => norm(b.text).includes('DEVELOPER'));
  assert.equal(dev.url, 'tg://user?id=777001', 'Developer opens the profile via tg://user?id=<DEVELOPER_ID>');
  assert.equal(developerLink(loadConfig({ DEVELOPER_URL: 'https://t.me/dev' })), 'https://t.me/dev');
  assert.equal(developerLink(loadConfig({})), '');
  const g = await makeCtx();
  await say(g, USER, '/start');
  assert.ok(!kbTexts(g.tg.last('sendMessage')).some((t) => t.includes('DEVELOPER')));
});

test('BOT_NAME comes from config everywhere (no hardcoded name)', async () => {
  const f = await makeCtx({ env: { BOT_NAME: 'Zephyr', WELCOME_EFFECT: 'false' } });
  await addSudoUser(f.db, SUDO, OWNER);
  const outputs = [];
  for (const [who, cmd] of [[USER, '/start'], [OWNER, '/start'], [SUDO, '/start'], [USER, '/about'], [USER, '/help'], [SUDO, '/panel'], [OWNER, '/sudo list']]) {
    f.tg.reset(); await say(f, who, cmd);
    outputs.push(...f.tg.calls.map((c) => JSON.stringify(c.params)));
  }
  const all = norm(outputs.join('\n'));
  assert.match(all, /Zephyr/);
  assert.doesNotMatch(all.replace(/NobaraTestBot/g, ''), /nobara/i);
  assert.equal(f.tg.last('sendMessage') && f.tg.sent('sendMessage').every((c) => c.params.message_effect_id === undefined), true, 'WELCOME_EFFECT=false disables the effect');
  const res = await handleRequest(new Request('https://x.example.com/health'), f.env, { waitUntil() {} }, { db: f.db, tg: f.tg, botInfo: { id: BOT_ID, username: 'ZephyrBot' } });
  assert.match(await res.text(), /zephyr-bot/);
});

test('/start retries without the 🎉 effect when Telegram rejects it; existing data stays intact', async () => {
  const f = await makeCtx();
  f.tg.failWhen((m, p) => m === 'sendMessage' && p.message_effect_id, new (await import('../src/utils/errors.js')).TelegramError('Bad Request: invalid message effect identifier', { status: 400 }));
  await say(f, USER, '/start');
  const sends = f.tg.sent('sendMessage');
  assert.equal(sends.length, 2); assert.equal(sends[1].params.message_effect_id, undefined);
  assert.equal(await f.db.value('SELECT COUNT(*) FROM users WHERE telegram_user_id = ?', [USER]), 1);
});

test('buttons use the sans-bold capital style and the spec colours', async () => {
  const f = await makeCtx({ env: { DEVELOPER_ID: '777001', UPDATES_CHANNEL_URL: 'https://t.me/chan' } });
  await say(f, USER, '/start');
  const btns = kb(f.tg.last('sendMessage'));
  const commands = btns.find((b) => norm(b.text).includes('COMMANDS'));
  assert.match(commands.text, /𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦/);
  assert.equal(commands.style, 'primary');
  assert.equal(btns.find((b) => norm(b.text).includes('ADD TO GROUP')).style, 'success');
  await say(f, USER, '/help');
  assert.equal(kb(f.tg.last('sendMessage')).find((b) => norm(b.text).includes('CLOSE')).style, 'danger');
});

test('sudo management pages through long lists (5 per page, Next/Prev, each row opens that moderator)', async () => {
  const f = await makeCtx();
  for (let i = 0; i < 7; i++) await addSudoUser(f.db, 61000 + i, OWNER);
  const msg = { message_id: 80, chat: { id: OWNER, type: 'private' } };
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(OWNER, msg, 'pn:sd:0') }));
  const p1 = kb(f.tg.last('editMessageText'));
  assert.ok(p1.some((b) => b.callback_data === 'pn:sd:1'), 'Next button on page 1');
  assert.equal(p1.filter((b) => /^pn:su:/.test(b.callback_data || '')).length, 5);
  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(OWNER, msg, 'pn:sd:1') }));
  const p2 = kb(f.tg.last('editMessageText'));
  assert.equal(p2.filter((b) => /^pn:su:/.test(b.callback_data || '')).length, 2);
  assert.ok(p2.some((b) => b.callback_data === 'pn:sd:0'), 'Prev button on page 2');
});
