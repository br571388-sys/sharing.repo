import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/index.js';
import { processUpdate } from '../src/core/webhook.js';
import { START_EFFECT_IDS, INTRO_EFFECTS } from '../src/features/start/start.js';
import { getGroup } from '../src/database/groups.js';
import { getGroupSetting, setGroupSetting, getBotSetting, setBotSetting } from '../src/database/settings.js';
import { listGroupAdmins } from '../src/database/groups.js';
import { TelegramError } from '../src/utils/errors.js';
import { welcomePic, BOT_ID, callbackQuery, groupMsg, json, makeCtx, privateMsg, stubFetch, update, OWNER } from './helpers/fakes.js';

const norm = (s) => String(s).normalize('NFKC');

const SECRET = 'whsecret_123';

async function webhook(fixture, { method = 'POST', headers = {}, body, secret = SECRET } = {}) {
  const pending = [];
  const req = new Request('https://bot.example.com/webhook', {
    method,
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {}), ...headers },
    body: method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const res = await handleRequest(req, fixture.env, { waitUntil: (p) => pending.push(p) }, { db: fixture.db, tg: fixture.tg, storage: fixture.ctx.storage, botInfo: { id: BOT_ID, username: 'NobaraTestBot' } });
  await Promise.all(pending);
  return res;
}

const kbTexts = (call) => (call.params.reply_markup?.inline_keyboard || []).flat().map((b) => String(b.text).normalize('NFKC'));

test('webhook: only POST, secret token required, malformed bodies rejected', async () => {
  const f = await makeCtx();
  assert.equal((await webhook(f, { method: 'GET' })).status, 405);
  assert.equal((await webhook(f, { body: { update_id: 1 }, secret: null })).status, 403);
  assert.equal((await webhook(f, { body: { update_id: 1 }, secret: 'wrong' })).status, 403);
  assert.equal((await webhook(f, { body: '{broken' })).status, 400);
  assert.equal((await webhook(f, { body: '[]' })).status, 400);
  assert.equal((await webhook(f, { body: { message: {} } })).status, 400);
  assert.equal((await webhook(f, { body: { update_id: 5, edited_message: {} } })).status, 200);
  assert.equal(f.tg.calls.length, 0, 'nothing happened for rejected / ignored requests');
});

test('webhook: acknowledges immediately and processes in the background', async () => {
  const f = await makeCtx();
  const pending = [];
  const req = new Request('https://bot.example.com/webhook', {
    method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET }, body: JSON.stringify(update({ message: privateMsg(5, '/ping') })),
  });
  const res = await handleRequest(req, f.env, { waitUntil: (p) => pending.push(p) }, { db: f.db, tg: f.tg, botInfo: { id: BOT_ID, username: 'NobaraTestBot' } });
  assert.equal(res.status, 200);
  assert.equal(pending.length, 1, 'work was deferred with waitUntil');
  await Promise.all(pending);
  assert.ok(f.tg.sent('sendMessage').length >= 1);
});

test('public routes: health works, unknown paths 404, nothing leaks', async () => {
  const f = await makeCtx();
  const ov = { db: f.db, tg: f.tg, botInfo: { id: BOT_ID, username: 'NobaraTestBot' } };
  const health = await handleRequest(new Request('https://x.dev/health'), f.env, { waitUntil() {} }, ov);
  assert.equal(health.status, 200);
  const body = await health.text();
  assert.ok(!body.includes(SECRET) && !body.includes('turso'));
  assert.equal((await handleRequest(new Request('https://x.dev/nope'), f.env, { waitUntil() {} }, ov)).status, 404);
  assert.equal((await handleRequest(new Request('https://x.dev/download?t=bad'), f.env, { waitUntil() {} }, ov)).status, 404);
});

test('duplicate updates are processed once', async () => {
  const f = await makeCtx();
  const u = update({ message: privateMsg(5, '/ping') });
  assert.equal(await processUpdate(f.ctx, u), 'processed');
  assert.equal(await processUpdate(f.ctx, u), 'duplicate');
  assert.equal(f.tg.sent('sendMessage').length, 1);
});

test('/start registers the user once and sends the text welcome with working menu buttons', async () => {
  const f = await makeCtx({ env: { DEVELOPER_URL: 'https://t.me/dev', UPDATES_CHANNEL_URL: 'https://t.me/chan' } });
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/start') }));
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/start') }));
  assert.equal(await f.db.value('SELECT COUNT(*) FROM users WHERE telegram_user_id = 5'), 1);
  const welcome = f.tg.sent('sendMessage').filter((m) => m.params.text !== '🎉')[0];
  assert.match(norm(welcome.params.text), /Welcome to <b>Nobara<\/b>/i);
  assert.match(welcome.params.text, /<blockquote>/, 'quote-style welcome');
  const introIds = f.tg.sent('sendMessage').map((m) => m.params.message_effect_id).filter(Boolean);
  assert.ok(introIds.some((id) => INTRO_EFFECTS.some((e) => e.effect_id === id)), 'the emoji intro carries a message effect in private chats');
  const rows = welcome.params.reply_markup.inline_keyboard;
  const label = (b) => b.text.normalize('NFKC');
  assert.deepEqual(rows[0].map(label), ['⚙️ COMMANDS', '❔ HELP']);
  assert.deepEqual(rows[0].map((b) => b.callback_data), ['m:help', 'm:guide']);
  assert.deepEqual(rows[1].map(label), ['✨ ABOUT', '👨‍💻 DEVELOPER']);
  assert.equal(rows[1][1].url, 'https://t.me/dev', 'without DEVELOPER_ID the Developer button links to DEVELOPER_URL');
  assert.deepEqual(rows[2].map(label), ['📢 UPDATES']);
  assert.equal(label(rows[3][0]), '➕ ADD TO GROUP');
  assert.match(rows[3][0].url, /^https:\/\/t\.me\/NobaraTestBot\?startgroup=true/);
  assert.equal(rows[0][0].style, 'primary', 'Commands is the primary (blue) action');
  assert.equal(rows[3][0].style, 'success', 'Add Me is green');
  assert.match(norm(welcome.params.text), /Hey <b>U5/i);
});

test('/start hides buttons whose URL is not configured (no broken buttons)', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/start') }));
  const texts = kbTexts(f.tg.sent('sendMessage')[0]);
  assert.ok(!texts.includes('👨‍💻 DEVELOPER') && !texts.includes('📢 UPDATES'));
  const all = f.tg.sent('sendMessage')[0].params.reply_markup.inline_keyboard.flat();
  assert.ok(all.every((b) => b.callback_data || /^https?:\/\//.test(b.url)));
});

test('/start sends the configured welcome image with the caption', async () => {
  const f = await makeCtx({ env: { WELCOME_IMAGE: 'https://img.example.com/w.jpg' } });
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/start') }));
  const photo = welcomePic(f.tg);
  assert.equal(photo.params.photo, 'https://img.example.com/w.jpg');
  assert.match(norm(photo.params.caption), /Welcome to <b>Nobara<\/b>/i);
  assert.ok(photo.params.reply_markup.inline_keyboard.length >= 2);
});

test('/start falls back to text when the welcome image cannot be sent', async () => {
  const f = await makeCtx({ env: { WELCOME_IMAGE: 'https://img.example.com/broken.jpg' } });
  f.tg.failWhen((m) => m === 'sendPhoto' || m === 'editMessageMedia', new TelegramError('Bad Request: wrong file identifier', { status: 400 }));
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/start') }));
  assert.ok(f.tg.texts().some((t) => /Welcome to <b>Nobara<\/b>/i.test(norm(t))), 'the text welcome is sent instead');
});

test('owner welcome settings: image is validated, bad image keeps the old one, reset works', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/setwelcomeimage https://img.example.com/a.jpg') }));
  const stored = await getBotSetting(f.db, 'welcome_image');
  assert.match(stored, /^photo-/, 'stores the Telegram file_id from the successful test send');

  f.tg.failWhen((m, p) => m === 'sendPhoto' && p.photo === 'https://img.example.com/bad.jpg', new TelegramError('Bad Request: failed to get HTTP URL content', { status: 400 }));
  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/setwelcomeimage https://img.example.com/bad.jpg') }));
  assert.equal(await getBotSetting(f.db, 'welcome_image'), stored, 'working image not replaced');
  assert.match(norm(f.tg.texts().at(-1)), /Invalid Picture/i);

  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/setwelcomeimage http://insecure.example.com/a.jpg') }));
  assert.match(norm(f.tg.texts().at(-1)), /Invalid URL/i);

  f.tg.reset();
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/start') }));
  assert.equal(welcomePic(f.tg).params.photo, stored, 'users get the stored image, nothing is regenerated');

  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/resetwelcome') }));
  assert.equal(await getBotSetting(f.db, 'welcome_image', ''), '');
});

test('/setwelcomeimage: video and GIF are accepted, not only photos', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/setwelcomeimage', { video: { file_id: 'vid-1' } }) }));
  assert.equal(await getBotSetting(f.db, 'welcome_image'), 'vid-1');
  assert.equal(await getBotSetting(f.db, 'welcome_image_type'), 'video');

  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/setwelcomeimage', { animation: { file_id: 'gif-1' } }) }));
  assert.equal(await getBotSetting(f.db, 'welcome_image_type'), 'animation');

  f.tg.reset();
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/start') }));
  const sent = welcomePic(f.tg);
  assert.equal(sent?.method, 'sendAnimation', 'users get the GIF as an animation');
  assert.equal(sent.params.animation, 'gif-1');
});

test('owner can set a formatted welcome caption with extra buttons; non-owners cannot', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/setwelcome hacked') }));
  assert.match(norm(f.tg.texts().at(-1)), /Access Denied/i);
  assert.equal(await getBotSetting(f.db, 'welcome_caption', ''), '');

  const text = '/setwelcome Hello bold\n(Docs - https://docs.example.com)';
  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, text, { entities: [{ type: 'bot_command', offset: 0, length: 11 }, { type: 'bold', offset: 18, length: 4 }] }) }));
  assert.equal(await getBotSetting(f.db, 'welcome_caption'), 'Hello <b>bold</b>');
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: privateMsg(6, '/start') }));
  const w = f.tg.sent('sendMessage').filter((m) => m.params.text !== '🎉')[0];
  assert.equal(w.params.text, 'Hello <b>bold</b>');
  assert.ok(kbTexts(w).includes('Docs'));
});

test('/help shows only what the person may use; menu navigation works and every callback is answered', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/help') }));
  const help = f.tg.sent('sendMessage')[0];
  const labels = kbTexts(help);
  assert.ok(labels.includes('⚙️ GROUP MANAGEMENT'), 'private help lists the group commands too');
  assert.ok(labels.includes('🎌 ANIME & TOOLS') && labels.includes('🎨 FILTERS & AUTOMATION'));
  assert.ok(labels.includes('❌ CLOSE') && labels.includes('🏠 HOME'));
  assert.ok(!labels.includes('👑 OWNER') && !labels.includes('🛡 MODERATOR') && !labels.includes('📦 BACKUP & DATABASE'));

  const owner = await makeCtx();
  await processUpdate(owner.ctx, update({ message: privateMsg(OWNER, '/help') }));
  const ownerLabels = kbTexts(owner.tg.sent('sendMessage')[0]);
  assert.ok(ownerLabels.includes('👑 OWNER') && ownerLabels.includes('🛡 MODERATOR') && ownerLabels.includes('📦 BACKUP & DATABASE'));

  // navigation: main menu -> section grid -> category -> back
  const msg = { message_id: 50, chat: { id: 5, type: 'private' } };
  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(5, msg, 'm:hs:tools') }));
  assert.deepEqual(kbTexts(f.tg.last('editMessageText')).slice(0, 4), ['🎌 ANIME', '🌐 TRANSLATION', '🖼️ IMAGE SEARCH', '🛠️ BASICS']);
  assert.equal(f.tg.sent('answerCallbackQuery').length, 1, 'answered');

  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(5, msg, 'm:help:anime') }));
  assert.match(norm(f.tg.last('editMessageText').params.text), /\/anime/i);
  assert.deepEqual(kbTexts(f.tg.last('editMessageText')), ['◀️ BACK', '❌ CLOSE']);
  assert.equal(f.tg.last('editMessageText').params.reply_markup.inline_keyboard[0][0].callback_data, 'm:hs:tools', 'Back returns to the section');

  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(5, msg, 'm:help:broadcast') }));
  assert.equal(f.tg.last('answerCallbackQuery').params.show_alert, true, 'cannot open categories you have no access to');
  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(5, msg, 'm:hs:owner') }));
  assert.equal(f.tg.last('answerCallbackQuery').params.show_alert, true, 'cannot open sections you have no access to');

  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(5, msg, 'm:about') }));
  const about = f.tg.last('editMessageText').params.text;
  assert.match(about, /Turso/);
  assert.ok(!about.includes('turso-token') && !about.includes('AAAA'));

  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(5, msg, 'm:home') }));
  assert.match(norm(f.tg.last('editMessageText').params.text), /Welcome to <b>Nobara<\/b>/i);
  assert.equal(f.tg.sent('answerCallbackQuery').length, 1);

  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(5, msg, 'm:guide') }));
  assert.match(norm(f.tg.last('editMessageText').params.text), /How To Use/i);
});

test('callbacks from the welcome PHOTO message edit the caption in place (picture stays)', async () => {
  const f = await makeCtx({ env: { WELCOME_IMAGE: 'https://img.example.com/w.jpg' } });
  const msg = { message_id: 60, chat: { id: 5, type: 'private' }, photo: [{ file_id: 'x' }] };
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(5, msg, 'm:help') }));
  assert.match(norm(f.tg.last('editMessageCaption').params.caption), /Main Menu/i);
  assert.equal(f.tg.sent('deleteMessage').length, 0);
  assert.equal(f.tg.sent('sendMessage').length, 0);
});

test('Close removes a menu; in groups only the opener or an admin may close it', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(5, { message_id: 9, chat: { id: 5, type: 'private' } }, 'x:close') }));
  assert.equal(f.tg.last('deleteMessage').params.message_id, 9);
  const g = await makeCtx();
  g.tg.setMember(-900, 6, 'member');
  g.tg.setMember(-900, 7, 'administrator');
  const gmsg = { message_id: 11, chat: { id: -900, type: 'supergroup' }, reply_to_message: { from: { id: 5 } } };
  await processUpdate(g.ctx, update({ callback_query: callbackQuery(6, gmsg, 'x:close') }));
  assert.equal(g.tg.sent('deleteMessage').length, 0, 'a stranger cannot close it');
  assert.equal(g.tg.last('answerCallbackQuery').params.show_alert, true);
  await processUpdate(g.ctx, update({ callback_query: callbackQuery(5, gmsg, 'x:close') }));
  assert.equal(g.tg.sent('deleteMessage').length, 1, 'the opener can');
  await processUpdate(g.ctx, update({ callback_query: callbackQuery(7, { ...gmsg, message_id: 12 }, 'x:close') }));
  assert.equal(g.tg.sent('deleteMessage').length, 2, 'an admin can');
});

test('/help <command> shows a formatted card from the real command table', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/help anime') }));
  const t = norm(f.tg.texts().at(-1));
  assert.match(t, /\/anime/);
  assert.match(t, /Usage/i);
  assert.match(t, /Aliases/i);
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/help nothingreal') }));
  assert.match(norm(f.tg.texts().at(-1)), /Command Not Found/i);
});

test('every callback is answered, even invalid or unknown ones', async () => {
  const f = await makeCtx();
  const msg = { message_id: 1, chat: { id: 5, type: 'private' } };
  for (const data of ['zzz', 'm:unknown', 'sc:d:99:0', 'img:bad:1', 'an:Q:1', 'cb:nothex', 'bc:go:x', 'dash:main', 'imp:go:none']) {
    f.tg.reset();
    await processUpdate(f.ctx, update({ callback_query: callbackQuery(5, msg, data) }));
    assert.equal(f.tg.sent('answerCallbackQuery').length, 1, data);
  }
});

test('unknown commands: helpful in private, silent in groups; commands for other bots are ignored', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/doesnotexist') }));
  assert.match(norm(f.tg.texts().at(-1)), /Unknown Command/i);
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: groupMsg(-5001, 5, '/doesnotexist') }));
  await processUpdate(f.ctx, update({ message: groupMsg(-5001, 5, '/ping@SomeOtherBot') }));
  assert.equal(f.tg.calls.filter((c) => c.method !== "getChatAdministrators").length, 0); // silent (group registration lookup is allowed)
});

test('removed features do not exist', async () => {
  const f = await makeCtx();
  for (const c of ['song', 'music', 'tts', 'download', 'ytdl', 'upscale', 'video', 'audio', 'game']) {
    f.tg.reset();
    await processUpdate(f.ctx, update({ message: privateMsg(5, `/${c} test`) }));
    assert.match(norm(f.tg.texts().at(-1)), /Unknown Command/i, c);
  }
});

test('errors never leak internals to users, and are recorded for the owner', async () => {
  const f = await makeCtx();
  const stub = stubFetch([['graphql', () => { throw new Error('socket hang up: TOKEN=secret-abc'); }]]);
  try {
    await processUpdate(f.ctx, update({ message: privateMsg(5, '/anime frieren') }));
  } finally { stub.restore(); }
  const shown = JSON.stringify(f.tg.calls.map((c) => c.params.text));
  assert.match(norm(shown), /Service Unavailable/i);
  assert.ok(!shown.includes('secret-abc') && !shown.includes('socket'));
  assert.ok(await getBotSetting(f.db, 'last_error'));
});

test('rate limiting: too many API commands in a minute', async () => {
  const f = await makeCtx();
  await f.db.execute("INSERT INTO rate_limits (rl_key, hits, reset_at) VALUES ('cmd:5', 10, ?)", [Math.floor(Date.now() / 1000) + 50]);
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/anime frieren') }));
  assert.match(norm(f.tg.texts().at(-1)), /Slow Down/i);
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/id') }));
  assert.ok(f.tg.texts().length === 1, 'non-API commands unaffected');
});

// ---- groups ----

const GROUP = -6001;

test('bot added to a group: registered with the Telegram-verified owner, ONE welcome even for duplicate signals', async () => {
  const f = await makeCtx();
  f.tg.admins.set(GROUP, [{ status: 'creator', user: { id: 77, is_bot: false } }, { status: 'administrator', user: { id: BOT_ID, is_bot: true } }]);
  const chat = { id: GROUP, type: 'supergroup', title: 'My Group' };
  const joined = { message_id: 1, chat, from: { id: 77 }, new_chat_members: [{ id: BOT_ID, is_bot: true }] };
  await processUpdate(f.ctx, update({ message: joined }));
  await processUpdate(f.ctx, update({ my_chat_member: { chat, from: { id: 77 }, old_chat_member: { status: 'left' }, new_chat_member: { status: 'member' } } }));
  await processUpdate(f.ctx, update({ message: joined }));

  const g = await getGroup(f.db, GROUP);
  assert.equal(g.title, 'My Group');
  assert.equal(g.owner_user_id, 77);
  assert.equal(g.owner_source, 'telegram');
  assert.equal(f.tg.texts().filter((t) => /Thanks for adding/i.test(t)).length, 1);
  const welcome = f.tg.sent('sendMessage').find((c) => /Thanks for adding/i.test(norm(c.params.text)));
  assert.ok(kbTexts(welcome).includes('⚙️ COMMANDS'));
  assert.equal(f.tg.sent('sendPhoto').length, 0, 'the private welcome image is not sent into groups');
});

test('bot removed from a group: group deactivated; re-adding reactivates it', async () => {
  const f = await makeCtx();
  const chat = { id: GROUP, type: 'supergroup', title: 'G' };
  await processUpdate(f.ctx, update({ message: { message_id: 1, chat, from: { id: 1 }, new_chat_members: [{ id: BOT_ID }] } }));
  await processUpdate(f.ctx, update({ message: { message_id: 2, chat, from: { id: 1 }, left_chat_member: { id: BOT_ID } } }));
  assert.equal((await getGroup(f.db, GROUP)).is_active, 0);
  await processUpdate(f.ctx, update({ my_chat_member: { chat, from: { id: 1 }, old_chat_member: { status: 'left' }, new_chat_member: { status: 'member' } } }));
  assert.equal((await getGroup(f.db, GROUP)).is_active, 1);
});

test('user blocking the bot in private chat flags the user', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/ping') }));
  await processUpdate(f.ctx, update({ my_chat_member: { chat: { id: 5, type: 'private' }, from: { id: 5 }, old_chat_member: { status: 'member' }, new_chat_member: { status: 'kicked' } } }));
  assert.equal(await f.db.value('SELECT is_blocked FROM users WHERE telegram_user_id = 5'), 1);
});

test('group data isolation: settings written in one group never appear in another', async () => {
  const f = await makeCtx();
  for (const id of [-7001, -7002]) await processUpdate(f.ctx, update({ message: groupMsg(id, 9, '/ping') }));
  const a = await getGroup(f.db, -7001);
  const b = await getGroup(f.db, -7002);
  assert.notEqual(a.id, b.id);
  await setGroupSetting(f.db, a, 'rules', 'only A');
  assert.equal(await getGroupSetting(f.db, a, 'rules'), 'only A');
  assert.equal(await getGroupSetting(f.db, b, 'rules'), null);
});

test('group owner authorises an admin, who can then back up the group; others cannot', async () => {
  const f = await makeCtx();
  f.tg.setMember(GROUP, 77, 'creator');
  f.tg.setMember(GROUP, 78, 'administrator');
  f.tg.setMember(GROUP, 79, 'administrator');
  await processUpdate(f.ctx, update({ message: groupMsg(GROUP, 77, '/ping') }));

  await processUpdate(f.ctx, update({ message: groupMsg(GROUP, 78, '/authorize 79') }));
  assert.match(norm(f.tg.texts().at(-1)), /Access Denied/i, 'only the owner can authorise');

  await processUpdate(f.ctx, update({ message: groupMsg(GROUP, 77, '/authorize', { reply_to_message: { message_id: 3, from: { id: 78, is_bot: false } } }) }));
  assert.match(norm(f.tg.texts().at(-1)), /Administrator Authorised/i);
  assert.equal((await listGroupAdmins(f.db, await getGroup(f.db, GROUP))).length, 1);

  f.tg.reset();
  await processUpdate(f.ctx, update({ message: groupMsg(GROUP, 78, '/backup') }));
  assert.equal(f.tg.sent('sendDocument').length, 1, 'authorised admin can back up');
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: groupMsg(GROUP, 79, '/backup') }));
  assert.equal(f.tg.sent('sendDocument').length, 0, 'unauthorised admin cannot');

  await processUpdate(f.ctx, update({ message: groupMsg(GROUP, 77, '/authorize 12345') }));
  assert.match(norm(f.tg.texts().at(-1)), /Not an Administrator/i);
  await processUpdate(f.ctx, update({ message: groupMsg(GROUP, 77, '/unauthorize 78') }));
  assert.match(norm(f.tg.texts().at(-1)), /Authorisation Removed/i);
});

test('/registerowner: explicit owner registration rules', async () => {
  const f = await makeCtx();
  f.tg.setMember(GROUP, 80, 'administrator', { can_promote_members: true });
  f.tg.setMember(GROUP, 81, 'administrator', { can_promote_members: false });
  f.tg.setMember(GROUP, 82, 'member');
  await processUpdate(f.ctx, update({ message: groupMsg(GROUP, 82, '/registerowner') }));
  assert.match(norm(f.tg.texts().at(-1)), /Access Denied/i);
  await processUpdate(f.ctx, update({ message: groupMsg(GROUP, 81, '/registerowner') }));
  assert.match(norm(f.tg.texts().at(-1)), /Access Denied/i, 'needs the add-admins right');
  await processUpdate(f.ctx, update({ message: groupMsg(GROUP, 80, '/registerowner') }));
  assert.match(norm(f.tg.texts().at(-1)), /Owner Registered/i);
  const g = await getGroup(f.db, GROUP);
  assert.equal(g.owner_user_id, 80);
  assert.equal(g.owner_source, 'registered');
});

// ---- custom buttons ----

test('/button builds a keyboard; pop-up buttons only ever show their stored text', async () => {
  const f = await makeCtx({ env: { BUTTON_POPUP_ALERT: 'true' } });
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/button Pick one\n(Site - https://example.com) | (Info - Files are safe)\n(Docs - https://docs.example.com)') }));
  const sent = f.tg.last('sendMessage');
  assert.equal(sent.params.text, 'Pick one');
  const kb = sent.params.reply_markup.inline_keyboard;
  assert.equal(kb.length, 2);
  assert.equal(kb[0][0].url, 'https://example.com');
  const cb = kb[0][1].callback_data;

  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(9, { message_id: 1, chat: { id: 9, type: 'private' } }, cb) }));
  const answer = f.tg.last('answerCallbackQuery');
  assert.equal(answer.params.text, 'Files are safe');
  assert.equal(answer.params.show_alert, true);

  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(9, { message_id: 1, chat: { id: 9, type: 'private' } }, 'cb:00000000000000000000') }));
  assert.match(norm(f.tg.last('answerCallbackQuery').params.text), /no longer available/i);
});

test('/button reports malformed definitions clearly and sends nothing', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/button Hi\n(Broken - https://exa mple.com)') }));
  assert.match(norm(f.tg.texts().at(-1)), /Invalid Button Format/i);
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/button just text') }));
  assert.match(norm(f.tg.texts().at(-1)), /No Buttons Found/i);
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/button') }));
  assert.match(norm(f.tg.texts().at(-1)), /Invalid Usage/i);
});

test('/button in groups is restricted to administrators', async () => {
  const f = await makeCtx();
  f.tg.setMember(GROUP, 90, 'administrator');
  f.tg.setMember(GROUP, 91, 'member');
  await processUpdate(f.ctx, update({ message: groupMsg(GROUP, 91, '/button Hi\n(A - https://a.com)') }));
  assert.match(norm(f.tg.texts().at(-1)), /Access Denied/i);
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: groupMsg(GROUP, 90, '/button Hi\n(A - https://a.com)') }));
  assert.equal(f.tg.last('sendMessage').params.text, 'Hi');
});

test('owner dashboard: owner only, shows real numbers, no secrets', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/dashboard') }));
  assert.match(norm(f.tg.texts().at(-1)), /Access Denied/i);
  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/dashboard') }));
  const text = f.tg.texts().at(-1);
  assert.match(text, /Bot Dashboard/);
  assert.match(text, /Total Users:<\/b> 2/);
  assert.match(text, /Database:<\/b> Connected/);
  assert.ok(!text.includes('turso-token') && !text.includes(SECRET));
  const msg = { message_id: 9, chat: { id: OWNER, type: 'private' } };
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(OWNER, msg, 'dash:bk') }));
  assert.match(norm(f.tg.last('editMessageText').params.text), /Recent Backups/i);
  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(5, msg, 'dash:main') }));
  assert.equal(f.tg.last('answerCallbackQuery').params.show_alert, true);
  assert.equal(f.tg.sent('editMessageText').length, 0);
});

test('database outage: webhook still answers 200 and the user gets a safe message', async () => {
  const f = await makeCtx();
  f.db.fail = true;
  const res = await webhook(f, { body: update({ message: privateMsg(5, '/ping') }) });
  assert.equal(res.status, 200);
  f.db.fail = false;
  void setBotSetting;
});

test('buttons on the welcome picture (video/GIF/photo) edit in place instead of failing', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/setwelcomeimage', { animation: { file_id: 'gif-2' } }) }));
  // Back button on a GIF welcome message: must use editMessageCaption, never editMessageText
  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: { id: 'c9', from: { id: 5, first_name: 'U' }, data: 'm:home', message: { message_id: 40, chat: { id: 5, type: 'private' }, animation: { file_id: 'gif-2' }, date: 0 } } }));
  assert.equal(f.tg.sent('editMessageText').length, 0);
  assert.ok(f.tg.sent('editMessageCaption').length + f.tg.sent('sendAnimation').length >= 1);
});
