import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, privateMsg, callbackQuery, OWNER } from './helpers/fakes.js';
import { getBotSetting } from '../src/database/settings.js';
import { coupleLinesCallback, handleTrollLineMessage, currentTrolls } from '../src/features/couple/coupleLines.js';
import { DEFAULT_TROLLS } from '../src/features/couple/couple.js';

const cq = (from, data) => callbackQuery(from, { chat: { id: from }, message_id: 3 }, data);

test('owner adds a line: it is saved escaped and appears in the list', async () => {
  const { ctx, db } = await makeCtx();
  const c = cq(OWNER, 'tl:a');
  await coupleLinesCallback(ctx, c, c.data.split(':'));
  assert.equal(await handleTrollLineMessage(ctx, privateMsg(OWNER, 'Tu <b>kaun</b> hai?')), true);
  const { lines, custom } = await currentTrolls(db);
  assert.equal(custom, true);
  assert.equal(lines.length, DEFAULT_TROLLS.length + 1);
  assert.equal(lines.at(-1), 'Tu &lt;b&gt;kaun&lt;/b&gt; hai?');
  // no pending line any more: the next message is not captured
  assert.equal(await handleTrollLineMessage(ctx, privateMsg(OWNER, 'hello')), false);
});

test('too long lines are refused and nothing is saved', async () => {
  const { ctx, db } = await makeCtx();
  const c = cq(OWNER, 'tl:a');
  await coupleLinesCallback(ctx, c, c.data.split(':'));
  assert.equal(await handleTrollLineMessage(ctx, privateMsg(OWNER, 'x'.repeat(201))), true);
  assert.equal(await getBotSetting(db, 'couple_trolls', ''), '');
});

test('non-owners cannot start an add, and reset returns to the defaults', async () => {
  const { ctx, db } = await makeCtx();
  const other = cq(9999, 'tl:a');
  await coupleLinesCallback(ctx, other, other.data.split(':'));
  assert.equal(await handleTrollLineMessage(ctx, privateMsg(9999, 'sneaky')), false);
  await db.execute("INSERT INTO bot_settings (setting_key, setting_value, updated_at) VALUES ('couple_trolls', '[\"a\"]', 1)");
  const r = cq(OWNER, 'tl:r');
  await coupleLinesCallback(ctx, r, r.data.split(':'));
  assert.equal((await currentTrolls(db)).lines.length, DEFAULT_TROLLS.length);
});
