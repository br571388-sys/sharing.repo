import test from 'node:test';
import assert from 'node:assert/strict';
import { processUpdate } from '../src/core/webhook.js';
import { flushActivityLog } from '../src/core/activityLog.js';
import { getBotSetting } from '../src/database/settings.js';
import { buttonLabel, setButtonMode } from '../src/ui/typography.js';
import { welcomePic, BOT_ID, OWNER, callbackQuery, groupMsg, makeCtx, privateMsg, update } from './helpers/fakes.js';

const norm = (s) => String(s).normalize('NFKC');
const kb = (call) => (call.params.reply_markup?.inline_keyboard || []).flat();
const LOG = -100777;

test('/setlogchannel: owner only, tests the channel, then every activity is posted there', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ message: privateMsg(55, `/setlogchannel ${LOG}`) }));
  assert.equal(await getBotSetting(f.db, 'log_channel'), null, 'non-owner cannot set it');
  f.tg.failWhen((m, p) => m === 'sendMessage' && p.chat_id === -100888, new Error('Bad Request: not enough rights to send'));
  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/setlogchannel -100888') }));
  assert.match(norm(f.tg.last('sendMessage').params.text), /COULD NOT POST THERE/);
  assert.equal(await getBotSetting(f.db, 'log_channel'), null, 'not saved when the test post fails');

  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, `/setlogchannel ${LOG}`) }));
  assert.equal(await getBotSetting(f.db, 'log_channel'), String(LOG));
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/ping') }));
  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/dashboard') }));
  await flushActivityLog(f.ctx);
  const toLog = f.tg.sent('sendMessage').filter((c) => c.params.chat_id === LOG);
  assert.ok(toLog.length >= 1, 'activity posted to the log channel');
  assert.match(toLog.map((c) => c.params.text).join('\n'), /\/dashboard/);
  assert.doesNotMatch(toLog.map((c) => c.params.text).join('\n'), /\/ping/, 'public commands are not logged (no spam)');

  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/setlogchannel off') }));
  assert.equal(await getBotSetting(f.db, 'log_channel'), '');
});

test('/buttonstyle: owner toggles block+bold and italic+bold; labels change everywhere', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/buttonstyle') }));
  assert.match(norm(f.tg.last('sendMessage').params.text), /ACCESS DENIED/, 'non-owner gets denied, not the panel');
  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/buttonstyle') }));
  const labels = kb(f.tg.last('sendMessage')).map((b) => b.text);
  assert.ok(labels.some((t) => /BLOCK/.test(norm(t))) && labels.some((t) => /ITALIC/.test(norm(t))), 'two toggle buttons');
  const msg = { message_id: 9, chat: { id: OWNER, type: 'private' } };
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(OWNER, msg, 'bs:set:italic') }));
  assert.equal(await getBotSetting(f.db, 'button_style'), 'italic');
  assert.equal(buttonLabel('Commands'), '𝘾𝙤𝙢𝙢𝙖𝙣𝙙𝙨');
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(5, msg, 'bs:set:block') }));
  assert.equal(await getBotSetting(f.db, 'button_style'), 'italic', 'a non-owner tap changes nothing');
  setButtonMode('block');
  assert.equal(buttonLabel('Commands'), '𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦');
});

test('private /help lists group commands too; group /help sends picture-style card with DM button and a reaction', async () => {
  const f = await makeCtx({ env: { REACTIONS: 'true' } });
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/help') }));
  const labels = kb(f.tg.last('sendMessage')).map((b) => norm(b.text));
  assert.ok(labels.includes('⚙️ GROUP MANAGEMENT'));

  f.tg.reset();
  await processUpdate(f.ctx, update({ message: groupMsg(-100500, 5, '/help') }));
  const card = f.tg.sent('sendMessage').at(-1);
  assert.match(kb(card)[0].url, /^https:\/\/t\.me\/NobaraTestBot\?start=help$/);
  assert.equal(norm(kb(card)[0].text), '📩 DM / HELP');
  assert.ok(f.tg.sent('setMessageReaction').length === 1, 'reaction on the /help command');
});

test('/start help (deep link from the group button) opens the private help', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/start help') }));
  assert.match(norm(f.tg.last('sendMessage').params.text), /MAIN MENU|Main Menu/i);
});

test('/id shows the IDs in monospace', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/id') }));
  assert.match(f.tg.last('sendMessage').params.text, /<code>5<\/code>/);
});

test('/afk and /unafk: replies to an AFK member show the reason; writing again clears it', async () => {
  const f = await makeCtx();
  const chat = { id: -100600, type: 'supergroup', title: 'G' };
  const base = (from, text, extra = {}) => ({ message_id: Math.floor(Math.random() * 1e6), chat, from: { id: from, first_name: `U${from}` }, text, ...extra });
  await processUpdate(f.ctx, update({ message: base(5, 'hi') }));
  await processUpdate(f.ctx, update({ message: base(5, '/afk gaming session') }));
  assert.match(norm(f.tg.last('sendMessage').params.text), /YOU ARE AFK/);
  await processUpdate(f.ctx, update({ message: base(6, 'hey', { reply_to_message: { message_id: 1, from: { id: 5, first_name: 'U5' }, chat } }) }));
  assert.match(norm(f.tg.last('sendMessage').params.text), /CURRENTLY AFK/);
  assert.match(f.tg.last('sendMessage').params.text, /gaming session/);
  await processUpdate(f.ctx, update({ message: base(5, 'back!') }));
  assert.match(norm(f.tg.last('sendMessage').params.text), /WELCOME BACK/);
  assert.match(f.tg.last('sendMessage').params.text, /Away for/, 'the return message says how long they were away');
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: base(6, 'hey again', { reply_to_message: { message_id: 1, from: { id: 5, first_name: 'U5' }, chat } }) }));
  assert.equal(f.tg.sent('sendMessage').length, 0, 'no AFK notice once cleared');
});

test('/approve exempts a member from locks, and /unapprove restores the rule', async () => {
  const f = await makeCtx();
  const chat = { id: -100601, type: 'supergroup', title: 'G' };
  f.tg.setMember(chat.id, BOT_ID, 'administrator', { can_delete_messages: true, can_restrict_members: true });
  f.tg.setMember(chat.id, 90, 'administrator', { can_delete_messages: true });
  const m = (from, text, extra = {}) => ({ message_id: Math.floor(Math.random() * 1e6), chat, from: { id: from, first_name: `U${from}` }, text, ...extra });
  await processUpdate(f.ctx, update({ message: m(90, '/lock links') }));
  await processUpdate(f.ctx, update({ message: m(90, '/approve 70007') }));
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: m(70007, 'see https://example.com') }));
  assert.equal(f.tg.sent('deleteMessage').length, 0, 'approved member is not affected by the lock');
  await processUpdate(f.ctx, update({ message: m(90, '/unapprove 70007') }));
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: m(70007, 'see https://example.com') }));
  assert.equal(f.tg.sent('deleteMessage').length, 1, 'lock applies again after /unapprove');
});

test('/setwelcomeimage shows two buttons; AUTO PFP uses the owner profile picture; manual turns it off', async () => {
  const f = await makeCtx();
  const realCall = f.tg.call.bind(f.tg);
  f.tg.call = async (method, params) => (method === 'getUserProfilePhotos' ? { photos: [[{ file_id: 'small' }, { file_id: 'pfp-big' }]] } : realCall(method, params));
  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/setwelcomeimage') }));
  const labels = kb(f.tg.last('sendMessage')).map((b) => norm(b.text));
  assert.ok(labels.some((t) => t.includes('AUTO PFP')) && labels.some((t) => t.includes('MANUAL IMAGE')));
  const msg = { message_id: 21, chat: { id: OWNER, type: 'private' } };
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(OWNER, msg, 'wi:pfp') }));
  assert.equal(await getBotSetting(f.db, 'welcome_auto_pfp'), '1');
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/start') }));
  assert.equal(welcomePic(f.tg).params.photo, 'pfp-big', 'the welcome uses the owner picture');
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(5, msg, 'wi:pfp') }));
  assert.equal(await getBotSetting(f.db, 'welcome_auto_pfp'), '1', 'a non-owner tap changes nothing');
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(OWNER, msg, 'wi:man') }));
  assert.equal(await getBotSetting(f.db, 'welcome_auto_pfp'), '0', 'manual mode turns auto PFP off');
});
