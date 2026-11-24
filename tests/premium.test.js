import test from 'node:test';
import assert from 'node:assert/strict';
import { processUpdate } from '../src/core/webhook.js';
import { TelegramError } from '../src/utils/errors.js';
import { parseButtons } from '../src/keyboards/buttonParser.js';
import { formatWelcome } from '../src/ui/design.js';
import { OWNER, makeCtx, privateMsg, update } from './helpers/fakes.js';

const norm = (s) => String(s).normalize('NFKC');

test('stats: Main Owner sees Sudo; sudo moderators and users do not; no uptime on the stats line', () => {
  const stats = { users: 6, groups: 4, sudo: 2 };
  const owner = norm(formatWelcome({ botName: 'Nobara', role: 'owner', stats }));
  const sudo = norm(formatWelcome({ botName: 'Nobara', role: 'sudo', stats }));
  const user = norm(formatWelcome({ botName: 'Nobara', role: 'user', stats }));
  assert.match(owner, /Users: 6 • 🌐 Groups: 4 • 🛡️ Sudo: 2/);
  for (const text of [sudo, user]) {
    assert.match(text, /Users: 6 • 🌐 Groups: 4/);
    assert.doesNotMatch(text, /Sudo: 2/, 'sudo count is private to the Main Owner');
  }
  for (const text of [owner, sudo, user]) assert.doesNotMatch(text, /Uptime/i, 'uptime is no longer shown');
  assert.doesNotMatch(owner, /<blockquote>[^]*?Users: 6[^]*?<\/blockquote>/, 'stats line is plain text, not a quote');
});

test('intro: text welcome, the emoji message is edited into the welcome (no delete)', async () => {
  const f = await makeCtx({ env: { REACTIONS: 'true' } });
  await processUpdate(f.ctx, update({ message: privateMsg(55, '/start') }));
  const reactions = f.tg.sent('setMessageReaction').length;
  assert.ok(reactions >= 4, `got ${reactions} reactions`);
  const teaser = f.tg.sent('sendMessage')[0];
  assert.ok(teaser?.params.message_effect_id, 'the emoji is sent with a message effect');
  assert.ok(f.tg.sent('editMessageText').length >= 1, 'the emoji message is edited into the welcome');
  assert.equal(f.tg.sent('sendPhoto').length, 0);
  assert.equal(f.tg.sent('deleteMessage').length, 0, 'no delete for a text welcome');
});

test('intro: picture welcome, the emoji text message is converted into the picture (editMessageMedia), no second message', async () => {
  const f = await makeCtx({ env: { REACTIONS: 'true', WELCOME_IMAGE: 'https://img.example.com/w.jpg' } });
  await processUpdate(f.ctx, update({ message: privateMsg(56, '/start') }));
  const teaser = f.tg.sent('sendMessage')[0];
  assert.ok(teaser?.params.message_effect_id, 'the emoji text has the effect');
  const conv = f.tg.sent('editMessageMedia')[0];
  assert.ok(conv, 'the emoji message is edited into the welcome picture');
  assert.equal(conv.params.media.type, 'photo');
  assert.equal(f.tg.sent('sendPhoto').length, 0, 'no second message');
  assert.equal(f.tg.sent('deleteMessage').length, 0);
});

test('intro: if Telegram refuses the picture edit, the emoji is deleted and the picture is sent without the effect', async () => {
  const f = await makeCtx({ env: { REACTIONS: 'true', WELCOME_IMAGE: 'https://img.example.com/w.jpg' } });
  f.tg.failWhen((m) => m === 'editMessageMedia', new TelegramError('Bad Request: message can\'t be edited', { status: 400 }));
  await processUpdate(f.ctx, update({ message: privateMsg(57, '/start') }));
  assert.equal(f.tg.sent('deleteMessage').length, 1, 'the emoji message is removed');
  const photo = f.tg.sent('sendPhoto')[0];
  assert.ok(photo, 'the welcome picture is sent');
  assert.equal(photo.params.message_effect_id, undefined, 'the picture is sent without the effect');
});
