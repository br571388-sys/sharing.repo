import test from 'node:test';
import assert from 'node:assert/strict';
import { processUpdate } from '../src/core/webhook.js';
import { addSudoUser } from '../src/database/roles.js';
import { captainIds } from '../src/core/captains.js';
import { callbackQuery, makeCtx, privateMsg, update, OWNER } from './helpers/fakes.js';

const SUDO_CAPTAIN = 77, SUDO_PLAIN = 78;
const norm = (s) => String(s).normalize('NFKC');
const cqMsg = { message_id: 900, chat: { id: OWNER, type: 'private' } };

test('captains: owner makes a sudo user Captain; the captain can broadcast, a plain sudo cannot', async () => {
  const { ctx, db, tg } = await makeCtx();
  await addSudoUser(db, SUDO_CAPTAIN, OWNER);
  await addSudoUser(db, SUDO_PLAIN, OWNER);

  // only the owner can promote, from /panel
  await processUpdate(ctx, update({ callback_query: callbackQuery(SUDO_PLAIN, cqMsg, `pn:cp:${SUDO_CAPTAIN}`) }));
  assert.deepEqual(await captainIds(db), []);
  await processUpdate(ctx, update({ callback_query: callbackQuery(OWNER, cqMsg, `pn:cp:${SUDO_CAPTAIN}`) }));
  assert.deepEqual(await captainIds(db), [SUDO_CAPTAIN]);

  tg.reset();
  await processUpdate(ctx, update({ message: privateMsg(SUDO_CAPTAIN, '/broadcast users hello') }));
  assert.match(norm(tg.texts().join('\n')), /Broadcast Preview|No Recipients|Queue/i, 'captain gets past the access check');
  assert.doesNotMatch(norm(tg.texts().join('\n')), /Access Denied|only the main owner/i);

  tg.reset();
  await processUpdate(ctx, update({ message: privateMsg(SUDO_PLAIN, '/broadcast users hello') }));
  assert.match(norm(tg.texts().join('\n')), /Access Denied|denied/i, 'a plain sudo user is still denied');
});

test('captain rank is removed when the user loses sudo', async () => {
  const { ctx, db, tg } = await makeCtx();
  await addSudoUser(db, SUDO_CAPTAIN, OWNER);
  await processUpdate(ctx, update({ callback_query: callbackQuery(OWNER, cqMsg, `pn:cp:${SUDO_CAPTAIN}`) }));
  await db.run('DELETE FROM sudo_users WHERE user_id = ?', [SUDO_CAPTAIN]);
  tg.reset();
  await processUpdate(ctx, update({ message: privateMsg(SUDO_CAPTAIN, '/broadcast users hello') }));
  assert.match(norm(tg.texts().join('\n')), /Access Denied|denied/i);
});

test('Pin & Send and Skip Pin set the pin flag on the broadcast job', async () => {
  const { ctx, db, tg } = await makeCtx();
  await processUpdate(ctx, update({ message: privateMsg(OWNER, '/broadcast users Big news') }));
  const prompt = tg.sent('sendMessage').find((c) => /Broadcast Preview/.test(c.params.text || ''));
  const [pinBtn, skipBtn] = prompt.params.reply_markup.inline_keyboard[0];
  assert.match(pinBtn.callback_data, /^bc:go:[\w-]+:pin:m$/);
  assert.match(skipBtn.callback_data, /^bc:go:[\w-]+:skip:m$/);

  await processUpdate(ctx, update({ callback_query: callbackQuery(OWNER, cqMsg, skipBtn.callback_data) }));
  const skipJob = await db.first('SELECT message_payload FROM broadcast_jobs ORDER BY id DESC LIMIT 1');
  assert.equal(JSON.parse(skipJob.message_payload).pin, false);
});
