import test from 'node:test';
import assert from 'node:assert/strict';
import { processUpdate } from '../src/core/webhook.js';
import { addSudoUser } from '../src/database/roles.js';
import { getBotSetting } from '../src/database/settings.js';
import { countGroupMessage, globalLeaderboardRows } from '../src/features/activity/activity.js';
import { callbackQuery, groupMsg, makeCtx, privateMsg, update, OWNER } from './helpers/fakes.js';

const norm = (s) => String(s).normalize('NFKC');
const T = Math.floor(Date.now() / 1000);

test('maintenance: while ON, a normal user gets the notice and nothing runs; the owner still works', async () => {
  const f = await makeCtx();
  await f.db.execute("INSERT INTO bot_settings (setting_key, setting_value, updated_at) VALUES ('maintenance', '1', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = '1'", [T]);
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/help') }));
  assert.match(norm(f.tg.texts().join('\n')), /under maintenance/i);
  assert.equal(f.tg.sent('sendMessage').filter((c) => /Help/i.test(c.params.text)).length, 0, 'the normal command did not run');
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/help') }));
  assert.equal(f.tg.sent('sendMessage').filter((c) => /under maintenance/i.test(norm(c.params.text))).length, 0, 'owner is not blocked');
});

test('maintenance: groups are silent for normal users; callbacks get a popup', async () => {
  const f = await makeCtx();
  await f.db.execute("INSERT INTO bot_settings (setting_key, setting_value, updated_at) VALUES ('maintenance', '1', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = '1'", [T]);
  await processUpdate(f.ctx, update({ message: groupMsg(-100700, 5, '/leaderboard') }));
  assert.equal(f.tg.calls.filter((c) => c.method === 'sendMessage' || c.method === 'sendPhoto').length, 0);
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(5, { message_id: 1, chat: { id: 5, type: 'private' } }, 'pn:m') }));
  assert.ok(f.tg.sent('answerCallbackQuery').some((c) => /maintenance/i.test(c.params.text || '')));
});

test('controls: only the owner can change them; a sudo moderator is refused', async () => {
  const f = await makeCtx();
  await addSudoUser(f.db, 77, OWNER);
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(77, { message_id: 1, chat: { id: 77, type: 'private' } }, 'pn:mt') }));
  assert.equal(await getBotSetting(f.db, 'maintenance', '0'), '0');
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(OWNER, { message_id: 1, chat: { id: OWNER, type: 'private' } }, 'pn:mt') }));
  assert.equal(await getBotSetting(f.db, 'maintenance', '0'), '1');
});

test('controls: stop / resume all clones and stop cloning are separate switches the owner can flip back', async () => {
  const f = await makeCtx();
  const cb = (data) => processUpdate(f.ctx, update({ callback_query: callbackQuery(OWNER, { message_id: 1, chat: { id: OWNER, type: 'private' } }, data) }));
  await cb('pn:ck');
  assert.equal(await getBotSetting(f.db, 'clones_paused', '0'), '1');
  await cb('pn:cn');
  assert.equal(await getBotSetting(f.db, 'cloning_enabled', '1'), '0');
  await cb('pn:ck');
  assert.equal(await getBotSetting(f.db, 'clones_paused', '0'), '0', 'resumed');
  await cb('pn:cn');
  assert.equal(await getBotSetting(f.db, 'cloning_enabled', '1'), '1', 'cloning allowed again');
  const screen = norm(f.tg.last('editMessageText').params.text);
  assert.match(screen, /BOT CONTROLS/);
  assert.match(JSON.stringify(f.tg.last('editMessageText').params.reply_markup), /pn:mt/);
});

test('global leaderboard: adds counts across every group, and keeps group boards separate', async () => {
  const f = await makeCtx();
  for (let i = 0; i < 2; i++) await countGroupMessage(f.db, { ...groupMsg(-100801, 40, 'a'), from: { id: 40, first_name: 'Asha' } }, T + i * 30);
  await countGroupMessage(f.db, { ...groupMsg(-100802, 40, 'a'), from: { id: 40, first_name: 'Asha' } }, T + 100);
  await countGroupMessage(f.db, { ...groupMsg(-100802, 41, 'a'), from: { id: 41, first_name: 'Ravi' } }, T + 200);
  const global = await globalLeaderboardRows(f.db, 'd', 10, T);
  assert.deepEqual(global.map((r) => [Number(r.user_id), Number(r.score)]), [[40, 3], [41, 1]]);
});
