import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, privateMsg, callbackQuery, stubFetch } from './helpers/fakes.js';
import { makeDb } from './helpers/fakeDb.js';
import { encryptSecret, decryptSecret, cloneKeyReady, newWebhookSecret } from '../src/core/cloneCrypto.js';
import { insertClone, getClone, getCloneSecrets, listClones, botIdTaken, cloneLimit, countOwnerClones, updateClone } from '../src/database/clones.js';
import { setBotSetting } from '../src/database/settings.js';
import { clonebotCommand, cloneStepMessage, cloneCallback } from '../src/features/clones/clonebot.js';
import { runCloneHealth } from '../src/features/clones/cloneHealth.js';
import { handleCloneRequest } from '../src/features/clones/cloneRuntime.js';
import { setAndVerifyCloneWebhook, cloneWebhookUrl } from '../src/features/clones/webhook.js';

const allText = (tg) => tg.texts().join('\n').toLowerCase();

const KEY = Buffer.alloc(32, 7).toString('base64');
const USER = 4242;
const BASE = 'https://worker.test';

async function setup(extraEnv = {}) {
  const made = await makeCtx({ env: { CLONE_ENCRYPTION_KEY: KEY, ...extraEnv } });
  await setBotSetting(made.db, 'public_base_url', BASE);
  made.ctx.config.cloneKey = KEY;
  return made;
}

test('clone crypto: round trip works and a bad key is rejected', async () => {
  assert.equal(cloneKeyReady(KEY), true);
  assert.equal(cloneKeyReady('abc'), false);
  const packed = await encryptSecret(KEY, '123456:secret-token-value-here-123456');
  assert.notEqual(packed.includes('secret-token'), true);
  assert.equal(await decryptSecret(KEY, packed), '123456:secret-token-value-here-123456');
  assert.match(newWebhookSecret(), /^[0-9a-f]{64}$/);
});

test('clones DAO: secrets stay out of getClone, limits and owner counts work', async () => {
  const db = await makeDb();
  const id = await insertClone(db, { owner_user_id: USER, bot_id: 777, bot_username: 'kid', bot_name: 'Kid', token_enc: 'a.b', db_url: 'libsql://x', db_token_enc: 'c.d', webhook_secret_enc: 'e.f' });
  const pub = await getClone(db, id);
  assert.equal(pub.token_enc, undefined);
  assert.equal(pub.db_token_enc, undefined);
  assert.equal((await getCloneSecrets(db, id)).token_enc, 'a.b');
  assert.equal(await botIdTaken(db, 777), true);
  assert.equal(await cloneLimit(db), 1);
  assert.equal(await countOwnerClones(db, USER), 1);
  assert.equal((await listClones(db, USER)).length, 1);
  await updateClone(db, id, { status: 'stopped', maintenance: 1, bogus_column: 'x' });
  assert.equal((await getClone(db, id)).status, 'stopped');
});

test('/clonebot: token is validated, Turso is set up, clone is stored, owner is notified', async () => {
  const { ctx, db, tg } = await setup();
  const cloneDb = await makeDb({ migrate: false });
  ctx.cloneDbFactory = () => cloneDb;
  let hookUrl = '';
  const stub = stubFetch([
    ['/getMe', { ok: true, result: { id: 5550001, is_bot: true, first_name: 'Kid', username: 'kidbot' } }],
    ['/setWebhook', (u, init) => { hookUrl = JSON.parse(init.body).url; return { ok: true, result: true }; }],
    ['/getWebhookInfo', () => ({ ok: true, result: { url: hookUrl, pending_update_count: 0 } })],
    ['/setMyShortDescription', { ok: true, result: true }],
    ['/setMyDescription', { ok: true, result: true }],
  ]);
  try {
    await clonebotCommand(ctx, privateMsg(USER, '/clonebot'));
    assert.ok(allText(tg).includes('create your clone bot'));
    assert.equal(await cloneStepMessage(ctx, privateMsg(USER, 'not a token')), true); // rejected, step stays
    const token = '5550001:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    assert.equal(await cloneStepMessage(ctx, privateMsg(USER, token)), true);
    assert.equal(await cloneStepMessage(ctx, privateMsg(USER, 'libsql://kid-db-user.turso.io')), true);
    assert.equal(await cloneStepMessage(ctx, privateMsg(USER, 'dbtoken-with-enough-length-123')), true);
    const rows = await db.all('SELECT * FROM clones');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'running');
    assert.equal(rows[0].bot_id, 5550001);
    assert.equal(rows[0].db_url, 'libsql://kid-db-user.turso.io');
    assert.ok(!String(rows[0].token_enc).includes('AAAA'));
    assert.equal(hookUrl, `${BASE}/webhook/clone/${rows[0].id}`);
    assert.ok(allText(tg).includes('clone bot created'));
    const logs = await db.all('SELECT kind, status FROM clone_notifications');
    assert.deepEqual(logs.map((l) => [l.kind, l.status]), [['created', 'sent']]);
    // one clone per user by default
    await clonebotCommand(ctx, privateMsg(USER, '/clonebot'));
    assert.ok(allText(tg).includes('limit reached'));
  } finally { stub.restore(); }
});

test('/clonebot: a rejected token never creates a clone and the main token is refused', async () => {
  const { ctx, db, tg } = await setup();
  const stub = stubFetch([['/getMe', () => ({ ok: false, description: 'Unauthorized' })]]);
  try {
    await clonebotCommand(ctx, privateMsg(USER, '/clonebot'));
    assert.equal(await cloneStepMessage(ctx, privateMsg(USER, '111111:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')), true);
    assert.equal((await db.all('SELECT * FROM clones')).length, 0);
    assert.ok(allText(tg).includes('token rejected'));
  } finally { stub.restore(); }
});

test('/clonebot: stopped cloning and a missing key are shown with the support button', async () => {
  const { ctx, db, tg } = await setup();
  await setBotSetting(db, 'cloning_enabled', '0');
  await clonebotCommand(ctx, privateMsg(USER, '/clonebot'));
  assert.ok(allText(tg).includes('cloning is stopped'));
  await setBotSetting(db, 'cloning_enabled', '1');
  ctx.config.cloneKey = null;
  await clonebotCommand(ctx, privateMsg(USER, '/clonebot'));
  assert.ok(allText(tg).includes('not set up'));
});

test('owner panel: stop sends a DM, restart re-verifies the webhook', async () => {
  const { ctx, db, tg } = await setup();
  const id = await insertClone(db, { owner_user_id: USER, bot_id: 777, bot_username: 'kid', bot_name: 'Kid', token_enc: await encryptSecret(KEY, '777:tok'), db_url: 'libsql://k', db_token_enc: await encryptSecret(KEY, 'dbtok-long-enough-123456'), webhook_secret_enc: await encryptSecret(KEY, 'sec'), status: 'running' });
  const stub = stubFetch([['/deleteWebhook', { ok: true, result: true }], ['/setWebhook', { ok: true, result: true }], ['/getWebhookInfo', () => ({ ok: true, result: { url: `${BASE}/webhook/clone/${id}` } })]]);
  try {
    const msg = { chat: { id: USER }, message_id: 9 };
    const stop = callbackQuery(USER, msg, `cl:s:${id}`);
    await cloneCallback(ctx, stop, stop.data.split(':'));
    assert.equal((await getClone(db, id)).status, 'stopped');
    assert.ok(allText(tg).includes('clone bot stopped'));
    const restart = callbackQuery(USER, msg, `cl:r:${id}`);
    await cloneCallback(ctx, restart, restart.data.split(':'));
    assert.equal((await getClone(db, id)).status, 'running');
  } finally { stub.restore(); }
});

test('owner panel: someone else cannot act on a clone', async () => {
  const { ctx, db, tg } = await setup();
  const id = await insertClone(db, { owner_user_id: USER, bot_id: 778, bot_username: 'k2', bot_name: 'K2', token_enc: 'a.b', db_url: 'libsql://k2', db_token_enc: 'c.d', webhook_secret_enc: 'e.f', status: 'running' });
  const cq = callbackQuery(9999, { chat: { id: 9999 }, message_id: 1 }, `cl:s:${id}`);
  await cloneCallback(ctx, cq, cq.data.split(':'));
  assert.equal((await getClone(db, id)).status, 'running');
});

test('webhook: setAndVerify reports a mismatch instead of claiming success', async () => {
  const { ctx } = await setup();
  const stub = stubFetch([['/setWebhook', { ok: true, result: true }], ['/getWebhookInfo', { ok: true, result: { url: 'https://other.example/x', last_error_message: 'Wrong response' } }]]);
  try {
    const res = await setAndVerifyCloneWebhook(ctx, 3, '999:tok', 'sec');
    assert.equal(res.ok, false);
    assert.match(res.error, /Wrong response|not have/);
  } finally { stub.restore(); }
});

test('cron: repeated webhook failures notify the owner once', async () => {
  const { ctx, db, tg } = await setup();
  const id = await insertClone(db, { owner_user_id: USER, bot_id: 779, bot_username: 'k3', bot_name: 'K3', token_enc: await encryptSecret(KEY, '779:tok'), db_url: 'libsql://k3', db_token_enc: await encryptSecret(KEY, 'dbtok-long-enough-123456'), webhook_secret_enc: await encryptSecret(KEY, 's'), status: 'running' });
  const stub = stubFetch([['/getWebhookInfo', { ok: true, result: { url: '' } }]]);
  try {
    const start = Date.now();
    for (let i = 0; i < 4; i++) await runCloneHealth(ctx, new Date(start + i * 700_000));
    assert.equal((await getClone(db, id)).status, 'webhook_failed');
    const alerts = (await db.all("SELECT kind FROM clone_notifications WHERE kind = 'webhook_failed'")).length;
    assert.equal(alerts, 1);
    assert.equal((await runCloneHealth(ctx, new Date(start + 0))).skipped, undefined);
  } finally { stub.restore(); }
});

test('cron: paused clones are skipped', async () => {
  const { ctx, db } = await setup();
  await setBotSetting(db, 'clones_paused', '1');
  assert.deepEqual(await runCloneHealth(ctx), { skipped: 'paused' });
});

test('clone endpoint: wrong secret is refused, paused and GET are gated', async () => {
  const { ctx, db } = await setup();
  const id = await insertClone(db, { owner_user_id: USER, bot_id: 780, bot_username: 'k4', bot_name: 'K4', token_enc: await encryptSecret(KEY, '780:tok'), db_url: 'libsql://k4', db_token_enc: await encryptSecret(KEY, 'dbtok-long-enough-123456'), webhook_secret_enc: await encryptSecret(KEY, 'right-secret'), status: 'running' });
  const env = { CLONE_ENCRYPTION_KEY: KEY };
  const url = `${BASE}/webhook/clone/${id}`;
  const post = (secret) => new Request(url, { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: '{}' });
  const overrides = { db, config: ctx.config, tg: ctx.tg };
  assert.equal((await handleCloneRequest(post('wrong'), env, null, overrides)).status, 403);
  assert.equal((await handleCloneRequest(new Request(url, { method: 'GET' }), env, null, overrides)).status, 405);
  await setBotSetting(db, 'clones_paused', '1');
  assert.equal((await handleCloneRequest(post('right-secret'), env, null, overrides)).status, 503);
});
