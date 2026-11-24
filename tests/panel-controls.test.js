import test from 'node:test';
import assert from 'node:assert/strict';
import { processUpdate } from '../src/core/webhook.js';
import { addSudoUser, isSudoUser } from '../src/database/roles.js';
import { captainIds, captainPerms, isCaptain } from '../src/core/captains.js';
import { getBotSetting } from '../src/database/settings.js';
import { callbackQuery, makeCtx, privateMsg, update, OWNER } from './helpers/fakes.js';

const MOD = 77, OTHER_MOD = 78;
const norm = (s) => String(s).normalize('NFKC');
const cqMsg = { message_id: 900, chat: { id: OWNER, type: 'private' } };
const press = (ctx, from, data) => processUpdate(ctx, update({ callback_query: callbackQuery(from, cqMsg, data) }));

test('panel: tapping a moderator opens controls with promote, send message and remove', async () => {
  const f = await makeCtx();
  await addSudoUser(f.db, MOD, OWNER);
  await press(f.ctx, OWNER, `pn:su:${MOD}`);
  const kb = JSON.stringify(f.tg.last('editMessageText').params.reply_markup);
  assert.match(kb, new RegExp(`pn:cp:${MOD}`), 'promote to captain');
  assert.match(kb, new RegExp(`pn:sm:${MOD}`), 'send message');
  assert.match(kb, new RegExp(`pn:sr:${MOD}`), 'remove');
});

test('panel: promote and demote switch the captain rank; only the owner can use them', async () => {
  const f = await makeCtx();
  await addSudoUser(f.db, MOD, OWNER);
  await press(f.ctx, OTHER_MOD, `pn:cp:${MOD}`);
  assert.equal(await isCaptain(f.db, MOD), false, 'non-owner cannot promote');
  await addSudoUser(f.db, OTHER_MOD, OWNER);
  await press(f.ctx, OWNER, `pn:cp:${MOD}`);
  assert.equal(await isCaptain(f.db, MOD), true);
  assert.match(JSON.stringify(f.tg.last('editMessageText').params.reply_markup), new RegExp(`pn:cd:${MOD}`), 'now offers demote');
  await press(f.ctx, OWNER, `pn:cd:${MOD}`);
  assert.equal(await isCaptain(f.db, MOD), false);
  assert.deepEqual(await captainIds(f.db), []);
  assert.equal(await isSudoUser(f.db, MOD), true, 'demoted users stay sudo');
});

test('panel: remove sudo also clears the captain rank', async () => {
  const f = await makeCtx();
  await addSudoUser(f.db, MOD, OWNER);
  await press(f.ctx, OWNER, `pn:cp:${MOD}`);
  await press(f.ctx, OWNER, `pn:sy:${MOD}`);
  assert.equal(await isSudoUser(f.db, MOD), false);
  assert.deepEqual(await captainIds(f.db), []);
});

test('panel: send message relays the owner’s next message to the moderator, once', async () => {
  const f = await makeCtx();
  await addSudoUser(f.db, MOD, OWNER);
  await press(f.ctx, OWNER, `pn:sm:${MOD}`);
  assert.match(norm(f.tg.last('editMessageText').params.text), /SEND MESSAGE/i);

  await processUpdate(f.ctx, update({ message: { message_id: 321, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'Owner' }, date: 1, text: 'Please check the log channel.' } }));
  const copy = f.tg.sent('copyMessage').find((c) => c.params.chat_id === MOD);
  assert.ok(copy, 'the message is copied to the moderator');
  assert.equal(copy.params.from_chat_id, OWNER);
  assert.equal(copy.params.message_id, 321);

  // a second message is no longer relayed
  const before = f.tg.sent('copyMessage').length;
  await processUpdate(f.ctx, update({ message: { message_id: 322, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'Owner' }, date: 2, text: 'hello again' } }));
  assert.equal(f.tg.sent('copyMessage').length, before);
});

test('panel: leaving the send prompt cancels it, and commands still run', async () => {
  const f = await makeCtx();
  await addSudoUser(f.db, MOD, OWNER);
  await press(f.ctx, OWNER, `pn:sm:${MOD}`);
  await press(f.ctx, OWNER, `pn:su:${MOD}`); // back
  await processUpdate(f.ctx, update({ message: { message_id: 330, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'Owner' }, date: 3, text: 'not for the moderator' } }));
  assert.equal(f.tg.sent('copyMessage').length, 0, 'cancelled prompt does not relay');
});

const ownerMsg = (id, text) => ({ message_id: id, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, first_name: 'Owner' }, date: 5, text });
const userMsg = (id, from, text) => ({ message_id: id, chat: { id: from, type: 'private' }, from: { id: from, first_name: 'Ravi' }, date: 6, text });

test('reply: the owner’s message to a moderator has a Reply button; the reply comes back to the owner', async () => {
  const f = await makeCtx();
  await addSudoUser(f.db, MOD, OWNER);
  await press(f.ctx, OWNER, `pn:sm:${MOD}`);
  await processUpdate(f.ctx, update({ message: ownerMsg(340, 'Check the group.') }));
  const relay = f.tg.sent('copyMessage').find((c) => c.params.chat_id === MOD);
  assert.match(JSON.stringify(relay.params.reply_markup), new RegExp(`ur:${OWNER}`), 'Reply button on the relayed message');

  // the moderator taps Reply, then answers
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(MOD, { message_id: 1, chat: { id: MOD, type: 'private' } }, `ur:${OWNER}`) }));
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: userMsg(350, MOD, 'Done, thanks') }));
  const header = f.tg.sent('sendMessage').find((c) => c.params.chat_id === OWNER);
  assert.match(header.params.text, /Reply from/);
  assert.match(JSON.stringify(header.params.reply_markup), new RegExp(`ou:${MOD}`), 'owner gets a Reply button');
  const copied = f.tg.sent('copyMessage').find((c) => c.params.chat_id === OWNER);
  assert.equal(copied.params.from_chat_id, MOD);
  assert.equal(copied.params.message_id, 350);
});

test('reply: without tapping Reply, a person’s message is not forwarded to the owner', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ message: userMsg(360, MOD, 'hello') }));
  assert.equal(f.tg.sent('copyMessage').filter((c) => c.params.chat_id === OWNER).length, 0);
});

test('reply: the owner taps ✉️ Reply and the next message goes to that person', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(MOD, { message_id: 1, chat: { id: MOD, type: 'private' } }, `ur:${OWNER}`) }));
  await processUpdate(f.ctx, update({ message: userMsg(370, MOD, 'hi') }));
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(OWNER, { message_id: 2, chat: { id: OWNER, type: 'private' } }, `ou:${MOD}`) }));
  await processUpdate(f.ctx, update({ message: ownerMsg(380, 'Thanks for the update.') }));
  const toMod = f.tg.sent('copyMessage').filter((c) => c.params.chat_id === MOD);
  assert.ok(toMod.some((c) => c.params.message_id === 380), 'owner reply reaches the person');
});

test('panel: a video or GIF welcome gets its panel in the caption, not a text edit', async () => {
  const f = await makeCtx();
  await addSudoUser(f.db, MOD, OWNER);
  const video = { message_id: 90, chat: { id: OWNER, type: 'private' }, video: { file_id: 'v' } };
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(OWNER, video, 'pn:m') }));
  assert.equal(f.tg.sent('editMessageText').length, 0);
  assert.ok(f.tg.sent('editMessageCaption').length >= 1 || f.tg.sent('sendMessage').length >= 1, 'panel shown');
});

test('captain permissions: a captain can use /setwelcome only after the owner allows it in /panel', async () => {
  const f = await makeCtx();
  await addSudoUser(f.db, MOD, OWNER);
  await press(f.ctx, OWNER, `pn:cp:${MOD}`);
  await processUpdate(f.ctx, update({ message: privateMsg(MOD, '/setwelcome Hello from captain') }));
  assert.match(norm(f.tg.texts().join('\n')), /Only the bot owner, or a captain the owner allowed/);
  assert.equal(await getBotSetting(f.db, 'welcome_caption', ''), '', 'nothing changed yet');

  await press(f.ctx, OWNER, `pn:cx:${MOD}:welcome`);
  assert.deepEqual(await captainPerms(f.db, MOD), ['welcome']);
  assert.match(JSON.stringify(f.tg.last('editMessageText').params.reply_markup), new RegExp(`pn:cx:${MOD}:welcome`));
  await processUpdate(f.ctx, update({ message: privateMsg(MOD, '/setwelcome Hello from captain') }));
  assert.match(await getBotSetting(f.db, 'welcome_caption', ''), /Hello from captain/);

  // a permission is not a broadcast right: /buttonstyle is still denied
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: privateMsg(MOD, '/buttonstyle') }));
  assert.match(norm(f.tg.texts().join('\n')), /Only the bot owner, or a captain the owner allowed/);
});

test('captain permissions: a non-captain cannot be given permissions, and demotion clears them', async () => {
  const f = await makeCtx();
  await addSudoUser(f.db, MOD, OWNER);
  await press(f.ctx, OWNER, `pn:cx:${MOD}:welcome`);
  assert.deepEqual(await captainPerms(f.db, MOD), [], 'not a captain: nothing granted');
  await press(f.ctx, OWNER, `pn:cp:${MOD}`);
  await press(f.ctx, OWNER, `pn:cx:${MOD}:logs`);
  await press(f.ctx, OWNER, `pn:cd:${MOD}`);
  assert.deepEqual(await captainPerms(f.db, MOD), []);
  await press(f.ctx, OWNER, `pn:cp:${MOD}`);
  assert.deepEqual(await captainPerms(f.db, MOD), [], 'promoting again starts with no permissions');
});

test('relay: the recipient sees a quoted bot header above the owner’s message', async () => {
  const f = await makeCtx();
  await addSudoUser(f.db, MOD, OWNER);
  await press(f.ctx, OWNER, `pn:sm:${MOD}`);
  await processUpdate(f.ctx, update({ message: ownerMsg(390, 'Please update the log channel.') }));
  const header = f.tg.sent('sendMessage').find((c) => c.params.chat_id === MOD);
  assert.match(header.params.text, /<blockquote>.*bot owner sent you this message/s);
});
