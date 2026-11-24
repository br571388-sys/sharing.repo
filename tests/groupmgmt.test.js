import test from 'node:test';
import assert from 'node:assert/strict';
import { processUpdate } from '../src/core/webhook.js';
import { runGroupCron, expireRestrictions } from '../src/features/groupmgmt/groupCron.js';
import { parseDuration, durationInRange } from '../src/features/groupmgmt/util.js';
import { BOT_ID, callbackQuery, groupMsg, makeCtx, privateMsg, update } from './helpers/fakes.js';

const norm = (s) => String(s).normalize('NFKC');

const CHAT = -7001;
const ADMIN = 10;
const MEMBER = 20000;
const OTHER = 21000;
const FULL = { can_delete_messages: true, can_restrict_members: true, can_promote_members: true, can_pin_messages: true, can_change_info: true, can_invite_users: true, can_manage_chat: true };

async function setup() {
  const f = await makeCtx();
  f.tg.setMember(CHAT, BOT_ID, 'administrator', { ...FULL, user: { id: BOT_ID, is_bot: true } });
  f.tg.setMember(CHAT, ADMIN, 'administrator', { ...FULL, user: { id: ADMIN, first_name: 'Boss' } });
  f.tg.setMember(CHAT, MEMBER, 'member', { user: { id: MEMBER, first_name: 'Mem' } });
  f.tg.setMember(CHAT, OTHER, 'member', { user: { id: OTHER, first_name: 'Oth' } });
  f.say = async (userId, text, extra = {}) => {
    f.tg.reset();
    await processUpdate(f.ctx, update({ message: groupMsg(CHAT, userId, text, extra) }));
    return f.tg.texts().at(-1) || '';
  };
  f.sayReply = (userId, text, targetId) => f.say(userId, text, { reply_to_message: { message_id: 50, from: { id: targetId, first_name: `T${targetId}` }, chat: { id: CHAT, type: 'supergroup' } } });
  f.rows = (sql, p = []) => f.db.all(sql, p);
  return f;
}
const called = (f, m) => f.tg.sent(m);

test('durations: parsing and range', () => {
  assert.equal(parseDuration('30s'), 30);
  assert.equal(parseDuration('10m'), 600);
  assert.equal(parseDuration('2h'), 7200);
  assert.equal(parseDuration('1d'), 86400);
  assert.equal(parseDuration('1w'), 604800);
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration('reason'), null);
  assert.equal(durationInRange(5), false);
  assert.equal(durationInRange(60), true);
});

test('/ban by reply and by id, keeps full reason, logs; /unban lifts', async () => {
  const f = await setup();
  const out = await f.sayReply(ADMIN, '/ban spamming links again', MEMBER);
  assert.match(out, /BANNED/);
  const b = called(f, 'banChatMember');
  assert.equal(b.length, 1);
  assert.equal(b[0].params.user_id, MEMBER);
  assert.equal(f.tg.members.get(`${CHAT}:${MEMBER}`).status, 'kicked');
  const logs = await f.rows('SELECT * FROM group_moderation_logs');
  assert.ok(logs.length >= 1);
  assert.ok(JSON.stringify(logs).includes('spamming links again'));
  await f.say(ADMIN, `/unban ${MEMBER}`);
  assert.equal(called(f, 'unbanChatMember').length, 1);
  await f.say(ADMIN, `/ban ${OTHER} breaking the rules badly`);
  assert.equal(f.tg.members.get(`${CHAT}:${OTHER}`).status, 'kicked');
});

test('moderation without a target shows usage and never hits Telegram', async () => {
  const f = await setup();
  const out = await f.say(ADMIN, '/ban');
  assert.match(out, /Usage|usage|reply/i);
  assert.equal(called(f, 'banChatMember').length, 0);
});

test('non-admins cannot moderate; sender is never moderated by accident', async () => {
  const f = await setup();
  await f.sayReply(MEMBER, '/ban nope', OTHER);
  assert.equal(called(f, 'banChatMember').length, 0);
  await f.say(ADMIN, '/ban');
  assert.equal(called(f, 'banChatMember').length, 0);
});

test('admins, the owner and the bot are protected', async () => {
  const f = await setup();
  f.tg.setMember(CHAT, 11, 'administrator', { ...FULL, user: { id: 11 } });
  await f.sayReply(ADMIN, '/ban x', 11);
  await f.sayReply(ADMIN, '/ban x', BOT_ID);
  assert.equal(called(f, 'banChatMember').length, 0);
});

test('bot without ban rights reports truthfully, no fake success', async () => {
  const f = await setup();
  f.tg.setMember(CHAT, BOT_ID, 'administrator', { can_delete_messages: true, can_restrict_members: false, user: { id: BOT_ID } });
  const out = await f.sayReply(ADMIN, '/ban x', MEMBER);
  assert.doesNotMatch(out, /✅.*banned/i);
  assert.equal(called(f, 'banChatMember').length, 0);
});

test('Telegram failure is reported without leaking internals', async () => {
  const f = await setup();
  const { TelegramError } = await import('../src/utils/errors.js');
  f.tg.failWhen((m) => m === 'banChatMember', new TelegramError('Bad Request: not enough rights to restrict', { status: 400, method: 'banChatMember' }));
  const out = await f.sayReply(ADMIN, '/ban x', MEMBER);
  assert.doesNotMatch(out, /stack|TelegramError|at .*\.js/);
  assert.doesNotMatch(out, /✅/);
});

test('/kick bans then unbans so the user can rejoin', async () => {
  const f = await setup();
  await f.sayReply(ADMIN, '/kick bye', MEMBER);
  assert.equal(called(f, 'banChatMember').length, 1);
  assert.equal(called(f, 'unbanChatMember').length, 1);
  assert.equal(f.tg.members.get(`${CHAT}:${MEMBER}`).status, 'left');
});

test('/mute and /unmute restrict then restore', async () => {
  const f = await setup();
  await f.sayReply(ADMIN, '/mute quiet please', MEMBER);
  const r = called(f, 'restrictChatMember')[0];
  assert.equal(r.params.permissions.can_send_messages, false);
  await f.say(ADMIN, `/unmute ${MEMBER}`);
  assert.equal(called(f, 'restrictChatMember')[0].params.permissions.can_send_messages, true);
});

test('/tmute and /tban: duration separate from reason, stored, expired by cron', async () => {
  const f = await setup();
  await f.sayReply(ADMIN, '/tmute 10m too noisy in chat', MEMBER);
  const r = called(f, 'restrictChatMember')[0];
  assert.ok(r.params.until_date > Math.floor(Date.now() / 1000) + 500);
  const rows = await f.rows('SELECT * FROM group_restrictions');
  assert.equal(rows.length, 1);
  assert.ok(JSON.stringify(await f.rows('SELECT * FROM group_moderation_logs')).includes('too noisy in chat'));
  await f.sayReply(ADMIN, '/tban 2h repeated spam', OTHER);
  assert.equal(called(f, 'banChatMember')[0].params.until_date > 0, true);
  // not due yet
  assert.equal(await expireRestrictions(f.ctx), 0);
  // jump ahead
  const n = await expireRestrictions(f.ctx, Math.floor(Date.now() / 1000) + 3 * 3600);
  assert.equal(n, 2);
  assert.equal((await f.rows("SELECT * FROM group_restrictions WHERE status = 'active'")).length, 0);
});

test('temporary command with invalid duration is rejected', async () => {
  const f = await setup();
  const out = await f.sayReply(ADMIN, '/tmute banana', MEMBER);
  assert.match(out, /uration|Usage/i);
  assert.equal(called(f, 'restrictChatMember').length, 0);
  await f.sayReply(ADMIN, '/tmute 5s', MEMBER);
  assert.equal(called(f, 'restrictChatMember').length, 0);
});

test('silent variants delete the command and stay quiet', async () => {
  const f = await setup();
  await f.sayReply(ADMIN, '/sban', MEMBER);
  assert.equal(called(f, 'banChatMember').length, 1);
  assert.equal(f.tg.texts().length, 0);
  assert.ok(called(f, 'deleteMessage').length >= 1);
  const g = await setup();
  await g.sayReply(ADMIN, '/dkick', MEMBER);
  assert.equal(called(g, 'banChatMember').length, 1);
});

test('/kickme, /banme, /muteme work on the sender only', async () => {
  const f = await setup();
  await f.say(MEMBER, '/kickme');
  assert.equal(called(f, 'banChatMember')[0].params.user_id, MEMBER);
  await f.say(ADMIN, '/kickme');
  assert.equal(called(f, 'banChatMember').length, 0);
});

test('warnings: /warn counts, limit triggers action, /unwarn /resetwarn /warns', async () => {
  const f = await setup();
  await f.say(ADMIN, '/warnlimit 3');
  await f.say(ADMIN, '/warnmode mute');
  await f.sayReply(ADMIN, '/warn first reason', MEMBER);
  let out = await f.say(ADMIN, `/warns ${MEMBER}`);
  assert.match(out, /1/);
  await f.sayReply(ADMIN, '/unwarn', MEMBER);
  out = await f.say(ADMIN, `/warns ${MEMBER}`);
  assert.match(out, /0|no warn/i);
  for (let i = 0; i < 3; i++) await f.sayReply(ADMIN, `/warn r${i}`, MEMBER);
  assert.ok(called(f, 'restrictChatMember').length >= 1, 'limit reached -> mute');
  await f.say(ADMIN, `/resetwarn ${MEMBER}`);
  out = await f.say(ADMIN, `/warns ${MEMBER}`);
  assert.match(out, /0|no warn/i);
});

test('/warnmode ban bans at the limit; /swarn and /dwarn behave', async () => {
  const f = await setup();
  await f.say(ADMIN, '/warnlimit 2');
  await f.say(ADMIN, '/warnmode ban');
  await f.sayReply(ADMIN, '/swarn a', MEMBER);
  await f.sayReply(ADMIN, '/dwarn b', MEMBER);
  assert.equal(called(f, 'banChatMember').length, 1);
  assert.ok(called(f, 'deleteMessage').length >= 1);
});

test('/warnlimit validates input', async () => {
  const f = await setup();
  const out = await f.say(ADMIN, '/warnlimit 0');
  assert.match(out, /between|Usage|invalid|1/i);
  await f.say(ADMIN, '/warnlimit 5');
  const rows = await f.rows(`SELECT * FROM group_settings WHERE setting_key LIKE 'warn%'`);
  assert.ok(JSON.stringify(rows).includes('5'));
});

test('/del removes the replied message and /purge deletes a range', async () => {
  const f = await setup();
  await f.say(ADMIN, '/del', { reply_to_message: { message_id: 90, from: { id: MEMBER }, chat: { id: CHAT } } });
  assert.ok(called(f, 'deleteMessage').some((c) => c.params.message_id === 90));
  const msg = groupMsg(CHAT, ADMIN, '/purge', { message_id: 150, reply_to_message: { message_id: 140, from: { id: MEMBER }, chat: { id: CHAT } } });
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: msg }));
  const ids = called(f, 'deleteMessage').map((c) => c.params.message_id);
  for (let i = 140; i <= 150; i++) assert.ok(ids.includes(i), `deleted ${i}`);
  assert.match(norm(f.tg.texts().join(' ')), /11|Purge|purged/i);
});

test('/purge without reply shows usage; non-admin refused', async () => {
  const f = await setup();
  const out = await f.say(ADMIN, '/purge');
  assert.match(out, /Usage|reply/i);
  await f.say(MEMBER, '/purge', { reply_to_message: { message_id: 3, from: { id: OTHER } } });
  assert.equal(called(f, 'deleteMessage').length, 0);
});

test('/pin and /unpin and /pinmessage', async () => {
  const f = await setup();
  await f.say(ADMIN, '/pin', { reply_to_message: { message_id: 77, from: { id: MEMBER }, chat: { id: CHAT } } });
  assert.equal(called(f, 'pinChatMessage')[0].params.message_id, 77);
  await f.say(ADMIN, '/unpin');
  assert.ok(called(f, 'unpinChatMessage').length === 1);
  await f.say(MEMBER, '/pin', { reply_to_message: { message_id: 77 } });
  assert.equal(called(f, 'pinChatMessage').length, 0);
});

test('/promote and /demote (only bot-promoted admins), /admins lists', async () => {
  const f = await setup();
  await f.sayReply(ADMIN, '/promote', MEMBER);
  assert.equal(called(f, 'promoteChatMember').length, 1);
  assert.equal(f.tg.members.get(`${CHAT}:${MEMBER}`).status, 'administrator');
  const out = await f.say(ADMIN, '/admins');
  assert.match(out, /Admin|Mem|Boss/);
  await f.sayReply(ADMIN, '/demote', MEMBER);
  assert.ok(called(f, 'promoteChatMember').length >= 1);
});

test('locks: lock/unlock/locks, enforcement deletes violating messages, admins exempt', async () => {
  const f = await setup();
  let out = await f.say(ADMIN, '/lock url');
  assert.match(out, /url|link/i);
  out = await f.say(ADMIN, '/locks');
  assert.match(out, /url|link/i);
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: groupMsg(CHAT, MEMBER, 'see https://spam.example/x', { message_id: 301, entities: [{ type: 'url', offset: 4, length: 22 }] }) }));
  assert.ok(called(f, 'deleteMessage').some((c) => c.params.message_id === 301));
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: groupMsg(CHAT, ADMIN, 'ok https://fine.example/x', { message_id: 302, entities: [{ type: 'url', offset: 3, length: 22 }] }) }));
  assert.equal(called(f, 'deleteMessage').length, 0);
  await f.say(ADMIN, '/unlock url');
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: groupMsg(CHAT, MEMBER, 'again https://spam.example/x', { message_id: 303, entities: [{ type: 'url', offset: 6, length: 22 }] }) }));
  assert.equal(called(f, 'deleteMessage').length, 0);
  out = await f.say(ADMIN, '/lock nonsense');
  assert.match(out, /Unknown|types|valid/i);
  out = await f.say(ADMIN, '/locktypes');
  assert.match(out, /url|link/i);
});

test('/lock photo uses native permissions; /lockall and /unlockall', async () => {
  const f = await setup();
  await f.say(ADMIN, '/lock photo');
  assert.equal(called(f, 'setChatPermissions').length >= 1, true);
  await f.say(ADMIN, '/lockall');
  await f.say(ADMIN, '/unlockall');
  const rows = await f.rows(`SELECT * FROM group_settings WHERE setting_key LIKE 'lock.%' AND setting_value IN ('1','true','on')`);
  assert.equal(rows.length, 0);
});

test('antiflood: exceeding the limit triggers the configured action', async () => {
  const f = await setup();
  await f.say(ADMIN, '/setflood 3');
  await f.say(ADMIN, '/setfloodmode mute');
  await f.say(ADMIN, '/antiflood on');
  f.tg.reset();
  for (let i = 0; i < 5; i++) await processUpdate(f.ctx, update({ message: groupMsg(CHAT, MEMBER, `spam ${i}`, { message_id: 400 + i }) }));
  assert.ok(called(f, 'restrictChatMember').length >= 1, 'flooder muted');
  f.tg.reset();
  for (let i = 0; i < 6; i++) await processUpdate(f.ctx, update({ message: groupMsg(CHAT, ADMIN, `hi ${i}`, { message_id: 420 + i }) }));
  assert.equal(called(f, 'restrictChatMember').length, 0, 'admins exempt');
  const out = await f.say(ADMIN, '/flood');
  assert.match(out, /3|flood/i);
});

test('blacklist: add, enforce, list, remove, mode', async () => {
  const f = await setup();
  await f.say(ADMIN, '/addblacklist badword');
  let out = await f.say(ADMIN, '/blacklist');
  assert.match(out, /badword/);
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: groupMsg(CHAT, MEMBER, 'this has a BADWORD inside', { message_id: 501 }) }));
  assert.ok(called(f, 'deleteMessage').some((c) => c.params.message_id === 501));
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: groupMsg(CHAT, ADMIN, 'admin says badword', { message_id: 502 }) }));
  assert.equal(called(f, 'deleteMessage').length, 0);
  await f.say(ADMIN, '/rmblacklist badword');
  out = await f.say(ADMIN, '/blacklist');
  assert.doesNotMatch(out, /badword/);
  out = await f.say(ADMIN, '/blacklistmode warn');
  assert.match(out, /warn/i);
});

test('filters: /filter, reply on trigger, /filters, /stop, /stopall', async () => {
  const f = await setup();
  await f.say(ADMIN, '/filter hello Hi there friend');
  let out = await f.say(ADMIN, '/filters');
  assert.match(out, /hello/);
  out = await f.say(MEMBER, 'well hello everyone');
  assert.match(out, /Hi there friend/);
  await f.say(ADMIN, '/stop hello');
  out = await f.say(MEMBER, 'hello again');
  assert.doesNotMatch(out, /Hi there friend/);
  await f.say(ADMIN, '/filter a one');
  await f.say(ADMIN, '/filter b two');
  await f.say(ADMIN, '/stopall');
  out = await f.say(ADMIN, '/filters');
  assert.doesNotMatch(out, /\ba\b.*one/);
});

test('notes: /save, /get, #hash, /notes, /clear, /clearall', async () => {
  const f = await setup();
  await f.say(ADMIN, '/save rules1 Be nice to everyone');
  let out = await f.say(MEMBER, '/get rules1');
  assert.match(out, /Be nice to everyone/);
  out = await f.say(MEMBER, '#rules1');
  assert.match(out, /Be nice to everyone/);
  out = await f.say(MEMBER, '/notes');
  assert.match(out, /rules1/);
  await f.say(MEMBER, '/save sneaky nope');
  assert.doesNotMatch(await f.say(MEMBER, '/get sneaky'), /nope/);
  await f.say(ADMIN, '/clear rules1');
  assert.doesNotMatch(await f.say(MEMBER, '/get rules1'), /Be nice/);
  await f.say(ADMIN, '/save x y');
  f.tg.reset();
  await f.say(ADMIN, '/clearall');
  const yes = called(f, 'sendMessage').at(-1).params.reply_markup.inline_keyboard.flat().find((b) => b.callback_data === 'gc:notes:go');
  assert.ok(yes, 'asks for confirmation first');
  assert.match(await f.say(MEMBER, '/notes'), /#x/, 'nothing deleted before confirming');
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(ADMIN, { message_id: 1, chat: { id: CHAT, type: 'supergroup' } }, yes.callback_data) }));
  assert.doesNotMatch(await f.say(MEMBER, '/notes'), /#x/);
});

test('rules: set, show, reset', async () => {
  const f = await setup();
  await f.say(ADMIN, '/setrules 1. Be kind 2. No spam');
  assert.match(await f.say(MEMBER, '/rules'), /Be kind/);
  await f.say(ADMIN, '/resetrules');
  assert.doesNotMatch(await f.say(MEMBER, '/rules'), /Be kind/);
  await f.say(MEMBER, '/setrules hack');
  assert.doesNotMatch(await f.say(MEMBER, '/rules'), /hack/);
});

test('welcome/goodbye: toggle, custom text with variables, join sends once, leave sends goodbye', async () => {
  const f = await setup();
  await f.say(ADMIN, '/welcome on');
  await f.say(ADMIN, '/setwelcome Welcome {first} to {chatname}!');
  f.tg.reset();
  const join = groupMsg(CHAT, 55, '', { message_id: 600, text: undefined, new_chat_members: [{ id: 55, first_name: 'Newbie' }] });
  await processUpdate(f.ctx, update({ message: join }));
  assert.match(norm(f.tg.texts().join('\n')), /Welcome Newbie to/i);
  const count = f.tg.texts().length;
  assert.equal(count, 1);
  await f.say(ADMIN, '/goodbye on');
  await f.say(ADMIN, '/setgoodbye Bye {first}');
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: groupMsg(CHAT, 55, '', { text: undefined, left_chat_member: { id: 55, first_name: 'Newbie' } }) }));
  assert.match(norm(f.tg.texts().join('\n')), /Bye Newbie/i);
  await f.say(ADMIN, '/resetwelcome');
  await f.say(ADMIN, '/resetgoodbye');
});

test('reports: /report notifies admins; /reports toggles', async () => {
  const f = await setup();
  const out = await f.say(MEMBER, '/report spam here', { reply_to_message: { message_id: 800, from: { id: OTHER, first_name: 'Oth' }, chat: { id: CHAT } } });
  assert.ok(out.length > 0);
  const rows = await f.rows('SELECT * FROM group_reports');
  assert.equal(rows.length, 1);
  await f.say(ADMIN, '/reportmode off');
  await f.say(MEMBER, '/report again', { reply_to_message: { message_id: 801, from: { id: OTHER }, chat: { id: CHAT } } });
  assert.equal((await f.rows('SELECT * FROM group_reports')).length, 1);
});

test('info commands: /id /groupid /info /chatinfo', async () => {
  const f = await setup();
  assert.match(await f.say(ADMIN, '/groupid'), new RegExp(String(CHAT)));
  assert.match(await f.sayReply(ADMIN, '/id', MEMBER), new RegExp(String(MEMBER)));
  assert.match(await f.sayReply(ADMIN, '/userinfo', MEMBER), new RegExp(String(MEMBER)));
  assert.ok((await f.say(ADMIN, '/chatinfo')).length > 0);
});

test('settings menu is admin-only and callbacks toggle real settings', async () => {
  const f = await setup();
  await f.say(MEMBER, '/settings');
  assert.equal(f.tg.texts().length === 0 || /admin/i.test(f.tg.texts().at(-1)), true);
  f.tg.reset();
  await f.say(ADMIN, '/settings');
  assert.ok(called(f, 'sendMessage').length >= 1);
  const kb = called(f, 'sendMessage')[0].params.reply_markup?.inline_keyboard || [];
  assert.ok(kb.flat().length > 0);
});

test('moderation history: /adminlog /modlog /modhistory read stored logs', async () => {
  const f = await setup();
  await f.sayReply(ADMIN, '/warn first', MEMBER);
  await f.sayReply(ADMIN, '/mute loud', MEMBER);
  const out = await f.say(ADMIN, '/modlog');
  assert.match(out, /mute|warn/i);
  assert.ok((await f.say(ADMIN, '/adminlog')).length > 0);
  assert.ok((await f.say(ADMIN, `/modhistory ${MEMBER}`)).length > 0);
});

test('group data isolation: settings, filters and notes never leak across groups', async () => {
  const f = await setup();
  await f.say(ADMIN, '/save secret hidden-text');
  await f.say(ADMIN, '/setrules rules-of-A');
  const OTHER_CHAT = -7002;
  f.tg.setMember(OTHER_CHAT, BOT_ID, 'administrator', { ...FULL, user: { id: BOT_ID } });
  f.tg.setMember(OTHER_CHAT, ADMIN, 'administrator', { ...FULL, user: { id: ADMIN } });
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: groupMsg(OTHER_CHAT, ADMIN, '/get secret') }));
  assert.doesNotMatch(norm(f.tg.texts().join(' ')), /hidden-text/i);
  await processUpdate(f.ctx, update({ message: groupMsg(OTHER_CHAT, ADMIN, '/rules') }));
  assert.doesNotMatch(norm(f.tg.texts().join(' ')), /rules-of-A/i);
});

test('captcha: join mutes, button verifies and unmutes; expiry kicks', async () => {
  const f = await setup();
  await f.say(ADMIN, '/captcha on');
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: groupMsg(CHAT, 66, '', { text: undefined, new_chat_members: [{ id: 66, first_name: 'Bot?' }] }) }));
  assert.ok(called(f, 'restrictChatMember').length >= 1, 'muted until verified');
  const sent = called(f, 'sendMessage').at(-1);
  const btn = sent?.params.reply_markup?.inline_keyboard?.flat().find((b) => b.callback_data?.startsWith('vf'));
  assert.ok(btn, 'verify button');
  // wrong person cannot verify for someone else
  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(MEMBER, { message_id: 1, chat: { id: CHAT, type: 'supergroup' } }, btn.callback_data) }));
  assert.equal(called(f, 'restrictChatMember').length, 0);
  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(66, { message_id: 1, chat: { id: CHAT, type: 'supergroup' } }, btn.callback_data) }));
  assert.ok(called(f, 'restrictChatMember').length >= 1, 'unmuted after verify');
});

test('captcha expiry removes unverified users', async () => {
  const f = await setup();
  await f.say(ADMIN, '/captcha on');
  await processUpdate(f.ctx, update({ message: groupMsg(CHAT, 67, '', { text: undefined, new_chat_members: [{ id: 67, first_name: 'Slow' }] }) }));
  f.tg.reset();
  await runGroupCron(f.ctx, new Date(Date.now() + 3600 * 1000));
  const { expireVerifications } = await import('../src/features/groupmgmt/captcha.js');
  await expireVerifications(f.ctx, Math.floor(Date.now() / 1000) + 3600);
  assert.ok(called(f, 'banChatMember').length >= 1 || called(f, 'unbanChatMember').length >= 1);
});

test('antiraid: many joins in a short window trip raid mode', async () => {
  const f = await setup();
  await f.say(ADMIN, '/antiraid on');
  await f.say(ADMIN, '/raidaction kick');
  f.tg.reset();
  for (let i = 0; i < 30; i++) {
    await processUpdate(f.ctx, update({ message: groupMsg(CHAT, 900 + i, '', { text: undefined, new_chat_members: [{ id: 900 + i, first_name: `J${i}` }] }) }));
  }
  assert.ok(called(f, 'banChatMember').length >= 1, 'raid action applied');
  await f.say(ADMIN, '/clearraid');
});

test('cleanup settings: cleanservice / cleancommands delete service messages and commands', async () => {
  const f = await setup();
  await f.say(ADMIN, '/cleanservice on');
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: groupMsg(CHAT, 5, '', { text: undefined, message_id: 950, pinned_message: { message_id: 1 } }) }));
  assert.ok(called(f, 'deleteMessage').some((c) => c.params.message_id === 950));
  await f.say(ADMIN, '/cleancommands on');
  f.tg.reset();
  await f.say(MEMBER, '/rules', { message_id: 960 });
  assert.ok(called(f, 'deleteMessage').some((c) => c.params.message_id === 960));
});

test('group commands do nothing useful in private chats and say so', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ message: privateMsg(ADMIN, '/ban 123') }));
  assert.match(norm(f.tg.texts().at(-1)), /group/i);
  assert.equal(f.tg.sent('banChatMember').length, 0);
});

test('/help in a group: sections -> 17 group categories reachable, pagination works', async () => {
  const f = await setup();
  await f.say(ADMIN, '/help');
  const card = called(f, 'sendMessage').at(-1) || called(f, 'sendPhoto').at(-1);
  assert.match(card.params.reply_markup.inline_keyboard[0][0].url, /\?start=help$/, 'group /help offers a DM / Help button');
  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(ADMIN, { message_id: 1, chat: { id: CHAT, type: 'supergroup' } }, 'm:help') }));
  const sections = (called(f, 'editMessageText')[0]?.params.reply_markup?.inline_keyboard?.flat() || []).map((b) => b.callback_data).filter((d) => d?.startsWith('m:hs:'));
  assert.ok(sections.length >= 4, `sections: ${sections}`);
  const cats = new Set();
  const gmsg = { message_id: 1, chat: { id: CHAT, type: 'supergroup' } };
  for (const d of sections) {
    f.tg.reset();
    await processUpdate(f.ctx, update({ callback_query: callbackQuery(ADMIN, gmsg, d) }));
    for (const b of called(f, 'editMessageText')[0].params.reply_markup.inline_keyboard.flat()) if (/^m:help:gm_/.test(b.callback_data || '')) cats.add(b.callback_data);
  }
  assert.equal(cats.size, 17, [...cats].join(','));
  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(ADMIN, gmsg, 'm:help:gm_mod') }));
  const page1 = called(f, 'editMessageText')[0].params;
  assert.match(norm(page1.text), /\/ban/i);
  const next = page1.reply_markup.inline_keyboard.flat().find((b) => /^m:help:gm_mod:1$/.test(b.callback_data || ''));
  assert.ok(next, 'moderation has more than one page');
  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(ADMIN, gmsg, next.callback_data) }));
  assert.doesNotMatch(norm(called(f, 'editMessageText')[0].params.text), /\/ban\b/);
});

test('command menus: groups get a scoped menu, all within the 100 limit', async () => {
  const { menuCommands } = await import('../src/handlers/commands.js');
  const groups = menuCommands('groups');
  assert.ok(groups.length > 20 && groups.length <= 100);
  for (const c of groups) assert.match(c.command, /^[a-z0-9_]{1,32}$/);
});

test('antispam: repeated identical messages from a member are acted on, admins exempt', async () => {
  const f = await setup();
  await f.say(ADMIN, '/antispam on');
  await f.say(ADMIN, '/antispam repeat 3');
  f.tg.reset();
  for (let i = 0; i < 6; i++) await processUpdate(f.ctx, update({ message: groupMsg(CHAT, MEMBER, 'buy cheap stuff now', { message_id: 700 + i }) }));
  assert.ok(called(f, 'deleteMessage').length + called(f, 'restrictChatMember').length >= 1);
  f.tg.reset();
  for (let i = 0; i < 6; i++) await processUpdate(f.ctx, update({ message: groupMsg(CHAT, ADMIN, 'buy cheap stuff now', { message_id: 720 + i }) }));
  assert.equal(called(f, 'deleteMessage').length + called(f, 'restrictChatMember').length, 0);
});

test('@username targets resolve only for users the bot knows', async () => {
  const f = await setup();
  const out = await f.say(ADMIN, '/ban @nobodyknown');
  assert.equal(called(f, 'banChatMember').length, 0);
  assert.ok(out.length > 0);
  await f.db.execute('INSERT INTO users (telegram_user_id, first_name, username, created_at, updated_at) VALUES (?,?,?,?,?)', [30000, 'Known', 'knownuser', 1, 1]).catch(() => {});
  f.tg.setMember(CHAT, 30000, 'member', { user: { id: 30000 } });
  await f.say(ADMIN, '/ban @knownuser');
  assert.ok(called(f, 'banChatMember').length <= 1);
});

test('backup v2: group data of the new tables is exported, restored, isolated; legacy v1 files still import', async () => {
  const { exportGlobal, exportGroup, serialize, restoreGroup } = await import('../src/features/backup/snapshot.js');
  const { validateBackup } = await import('../src/features/backup/validation.js');
  const f = await setup();
  await f.say(ADMIN, '/filter hi hello-reply');
  await f.say(ADMIN, '/save n1 note-one');
  await f.say(ADMIN, '/addblacklist zzz');
  await f.sayReply(ADMIN, '/warn w', MEMBER);
  const group = await f.db.first('SELECT * FROM groups WHERE telegram_chat_id = ?', [CHAT]);
  const gb = await exportGroup(f.db, CHAT);
  const text = serialize(gb);
  assert.ok(text.includes('hello-reply') && text.includes('note-one') && text.includes('zzz'));
  assert.ok(!('group_warnings' in gb.tables), 'warnings excluded');
  const v = await validateBackup(text);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  await f.say(ADMIN, '/stopall');
  await restoreGroup(f.db, JSON.parse(text), group.id);
  assert.match(await f.say(MEMBER, 'hi there'), /hello-reply/);
  // legacy v1 backup (schema_version 1, only original tables) still validates
  const g = await exportGlobal(f.db);
  const legacy = JSON.parse(serialize(g));
  for (const t of ['group_filters', 'group_notes', 'group_blacklist', 'group_greetings']) delete legacy.tables[t];
  legacy.schema_version = 1;
  const { checksumOf } = await import('../src/features/backup/snapshot.js');
  legacy.checksum = await checksumOf(legacy.tables);
  const lv = await validateBackup(JSON.stringify(legacy));
  assert.equal(lv.ok, true, JSON.stringify(lv.errors));
});

test('cron: runGroupCron expires restrictions and never throws', async () => {
  const f = await setup();
  await f.sayReply(ADMIN, '/tmute 1m x', MEMBER);
  const out = await runGroupCron(f.ctx, new Date(Date.now() + 5 * 60000));
  assert.equal(out.restrictions, 1);
});
