import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, privateMsg, callbackQuery, stubFetch, OWNER } from './helpers/fakes.js';
import { makeDb } from './helpers/fakeDb.js';
import { encryptSecret } from '../src/core/cloneCrypto.js';
import { insertClone, getClone, updateClone } from '../src/database/clones.js';
import { setBotSetting } from '../src/database/settings.js';
import { isSudoUser } from '../src/database/roles.js';
import { cloneCallback, cloneStepMessage } from '../src/features/clones/clonebot.js';
import { exportCommand } from '../src/features/owner/exportDb.js';
import { buildCloneContext, cloneSecrets } from '../src/features/clones/cloneRuntime.js';
import { getCloneSecrets } from '../src/database/clones.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const CLONE_OWNER = 4242;
const MOD = 8585;
const cq = (from, data) => callbackQuery(from, { chat: { id: from }, message_id: 4 }, data);

async function setup() {
  const made = await makeCtx({ env: { CLONE_ENCRYPTION_KEY: KEY } });
  made.ctx.config.cloneKey = KEY;
  await setBotSetting(made.db, 'public_base_url', 'https://worker.test');
  const cloneDb = await makeDb();
  made.ctx.cloneDbFactory = () => cloneDb;
  const id = await insertClone(made.db, {
    owner_user_id: CLONE_OWNER, bot_id: 5550020, bot_username: 'mine', bot_name: 'Mine',
    token_enc: await encryptSecret(KEY, '5550020:tok'), db_url: 'libsql://mine', db_token_enc: await encryptSecret(KEY, 'dbtok-long-enough-123456'),
    webhook_secret_enc: await encryptSecret(KEY, 's'), status: 'running',
  });
  return { ...made, cloneDb, id };
}

test('clone owner adds a moderator by user id; it lives in the clone database only, and can be removed', async () => {
  const made = await setup();
  const add = cq(CLONE_OWNER, `cl:sa:${made.id}`);
  await cloneCallback(made.ctx, add, add.data.split(':'));
  assert.equal(await cloneStepMessage(made.ctx, privateMsg(CLONE_OWNER, 'not a number')), true);
  assert.equal(await cloneStepMessage(made.ctx, privateMsg(CLONE_OWNER, String(MOD))), true);
  assert.equal(await isSudoUser(made.cloneDb, MOD), true, 'moderator is in the clone database');
  assert.equal(await isSudoUser(made.db, MOD), false, 'not in the main database');
  const rm = cq(CLONE_OWNER, `cl:sr:${made.id}:${MOD}`);
  await cloneCallback(made.ctx, rm, rm.data.split(':'));
  assert.equal(await isSudoUser(made.cloneDb, MOD), false);
});

test('another user cannot manage a clone moderator list', async () => {
  const made = await setup();
  const add = cq(9999, `cl:sa:${made.id}`);
  await cloneCallback(made.ctx, add, add.data.split(':'));
  assert.equal(await cloneStepMessage(made.ctx, privateMsg(9999, String(MOD))), false);
  assert.equal(await isSudoUser(made.cloneDb, MOD), false);
});

test('/export inside a clone exports the clone database only, and says so', async () => {
  const made = await setup();
  const row = await getCloneSecrets(made.db, made.id);
  const clone = await getClone(made.db, made.id);
  const c = buildCloneContext(made.ctx, clone, await cloneSecrets(made.ctx.config, row), made.cloneDb);
  c.tg = made.tg;
  await exportCommand(c, privateMsg(CLONE_OWNER, '/export'));
  const doc = made.tg.calls.find((x) => x.method === 'sendDocument');
  assert.ok(doc, 'a file was sent');
  assert.match(String(doc.params.caption || doc.params.caption), /Clone bot export/i);
});

test('resuming a stopped clone says "started", not "restarted"', async () => {
  const made = await setup();
  await updateClone(made.db, made.id, { status: 'stopped', stopped_by: 'owner' });
  const stub = stubFetch([['/setWebhook', { ok: true, result: true }], ['/getWebhookInfo', () => ({ ok: true, result: { url: `https://worker.test/webhook/clone/${made.id}` } })]]);
  try {
    const q = cq(CLONE_OWNER, `cl:r:${made.id}`);
    await cloneCallback(made.ctx, q, q.data.split(':'));
    const kinds = (await made.db.all('SELECT kind FROM clone_notifications')).map((r) => r.kind);
    assert.ok(kinds.includes('started'));
    assert.ok(!kinds.includes('restarted'));
  } finally { stub.restore(); }
});
