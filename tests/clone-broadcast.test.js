import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, privateMsg, callbackQuery, stubFetch, OWNER } from './helpers/fakes.js';
import { makeDb } from './helpers/fakeDb.js';
import { encryptSecret } from '../src/core/cloneCrypto.js';
import { insertClone, getClone, getCloneSecrets, updateClone } from '../src/database/clones.js';
import { setBotSetting } from '../src/database/settings.js';
import { createJob } from '../src/database/broadcasts.js';
import { buildCloneContext, cloneSecrets } from '../src/features/clones/cloneRuntime.js';
import { cloneCallback } from '../src/features/clones/clonebot.js';
import { cloneManageCallback } from '../src/features/clones/clonesPanel.js';
import { runCloneBroadcastJobs } from '../src/features/clones/cloneBroadcast.js';
import { broadcastCommand, broadcastCallback } from '../src/features/broadcast/broadcast.js';
import { callbackQuery as cbq } from './helpers/fakes.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const CLONE_OWNER = 4242;
const norm = (s) => String(s).normalize('NFKC');
const now = () => Math.floor(Date.now() / 1000);

async function setup() {
  const made = await makeCtx({ env: { CLONE_ENCRYPTION_KEY: KEY } });
  made.ctx.config.cloneKey = KEY;
  await setBotSetting(made.db, 'public_base_url', 'https://worker.test');
  const cloneDb = await makeDb();
  made.ctx.cloneDbFactory = () => cloneDb;
  const id = await insertClone(made.db, {
    owner_user_id: CLONE_OWNER, bot_id: 5550010, bot_username: 'kidclone', bot_name: 'Kid',
    token_enc: await encryptSecret(KEY, '5550010:tok'), db_url: 'libsql://kid', db_token_enc: await encryptSecret(KEY, 'dbtok-long-enough-123456'),
    webhook_secret_enc: await encryptSecret(KEY, 's'), status: 'running',
  });
  return { ...made, cloneDb, id };
}

async function cloneCtx(made, approved) {
  await updateClone(made.db, made.id, { broadcast_approved: approved ? 1 : 0 });
  const row = await getCloneSecrets(made.db, made.id);
  const clone = await getClone(made.db, made.id);
  const c = buildCloneContext(made.ctx, clone, await cloneSecrets(made.ctx.config, row), made.cloneDb);
  c.tg = made.tg; // record the clone's replies with the same fake as the main bot
  return c;
}

test('main preview offers the clone choice only when a clone is approved and running', async () => {
  const made = await setup();
  await made.cloneDb.execute('SELECT 1');
  await made.db.execute("INSERT INTO users (telegram_user_id, first_name, created_at, updated_at) VALUES (9001, 'A', 1, 1)");
  await broadcastCommand(made.ctx, privateMsg(OWNER, '/broadcast users hello'), 'users hello', { name: 'broadcast', argsStart: 10 });
  const before = made.tg.calls.filter((c) => c.method === 'sendMessage').at(-1).params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(before.every((d) => !d.endsWith(':c')), 'no clone buttons while not approved');
  await updateClone(made.db, made.id, { broadcast_approved: 1 });
  made.tg.reset();
  await broadcastCommand(made.ctx, privateMsg(OWNER, '/broadcast users hello'), 'users hello', { name: 'broadcast', argsStart: 10 });
  const after = made.tg.calls.filter((c) => c.method === 'sendMessage').at(-1).params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(after.some((d) => /^bc:pick:[\w-]+:pin$/.test(d)), 'pin + choose clones button shown');
  assert.ok(after.some((d) => /^bc:pick:[\w-]+:skip$/.test(d)), 'no pin + choose clones button shown');
});

test('inside an unapproved clone, /broadcast shows a request button; the request reaches the Main Owner', async () => {
  const made = await setup();
  const c = await cloneCtx(made, false);
  await broadcastCommand(c, privateMsg(CLONE_OWNER, '/broadcast users hi'), 'users hi', { name: 'broadcast', argsStart: 10 });
  const last = c.tg.calls.filter((x) => x.method === 'sendMessage').at(-1);
  assert.ok(norm(last.params.text).toLowerCase().includes('not approved'));
  assert.equal(last.params.reply_markup.inline_keyboard[0][0].callback_data, 'cl:bq');

  const q = callbackQuery(CLONE_OWNER, { chat: { id: CLONE_OWNER, type: 'private' }, message_id: 2 }, 'cl:bq');
  await cloneCallback(c, q, q.data.split(':'));
  const toMain = made.tg.calls.filter((x) => x.method === 'sendMessage' && Number(x.params.chat_id) === OWNER).at(-1);
  assert.ok(toMain, 'Main Owner got the request');
  assert.match(JSON.stringify(toMain.params.reply_markup), new RegExp(`cm:ba:${made.id}`));
  assert.match(JSON.stringify(toMain.params.reply_markup), new RegExp(`cm:bd:${made.id}`));
});

test('a second request within an hour is refused', async () => {
  const made = await setup();
  const c = await cloneCtx(made, false);
  const q1 = callbackQuery(CLONE_OWNER, { chat: { id: CLONE_OWNER, type: 'private' }, message_id: 2 }, 'cl:bq');
  await cloneCallback(c, q1, q1.data.split(':'));
  const q2 = callbackQuery(CLONE_OWNER, { chat: { id: CLONE_OWNER, type: 'private' }, message_id: 2 }, 'cl:bq');
  await cloneCallback(c, q2, q2.data.split(':'));
  const toasts = c.tg.calls.filter((x) => x.method === 'answerCallbackQuery').map((x) => norm(x.params.text || ''));
  assert.match(toasts.at(-1), /already sent/i);
});

test('a stranger cannot request on behalf of a clone', async () => {
  const made = await setup();
  const c = await cloneCtx(made, false);
  const q = callbackQuery(999, { chat: { id: 999, type: 'private' }, message_id: 2 }, 'cl:bq');
  await cloneCallback(c, q, q.data.split(':'));
  assert.equal(made.tg.calls.filter((x) => x.method === 'sendMessage' && Number(x.params.chat_id) === OWNER).length, 0);
});

test('Main Owner accepts: the clone becomes approved and its owner is told', async () => {
  const made = await setup();
  const q = callbackQuery(OWNER, { chat: { id: OWNER, type: 'private' }, message_id: 3 }, `cm:ba:${made.id}`);
  await cloneManageCallback(made.ctx, q, q.data.split(':'));
  assert.equal((await getClone(made.db, made.id)).broadcast_approved, 1);
  const told = made.tg.calls.some((x) => x.method === 'sendMessage' && Number(x.params.chat_id) === CLONE_OWNER);
  assert.ok(told, 'clone owner notified');
});

test('Main Owner denies: nothing changes', async () => {
  const made = await setup();
  const q = callbackQuery(OWNER, { chat: { id: OWNER, type: 'private' }, message_id: 3 }, `cm:bd:${made.id}`);
  await cloneManageCallback(made.ctx, q, q.data.split(':'));
  assert.equal((await getClone(made.db, made.id)).broadcast_approved, 0);
});

test('a clone job is sent by the clone bot to the clone users, then completes', async () => {
  const made = await setup();
  await made.cloneDb.execute("INSERT INTO users (telegram_user_id, first_name, created_at, updated_at) VALUES (9101, 'U', 1, 1)");
  await updateClone(made.db, made.id, { broadcast_approved: 1 });
  const jobId = await createJob(made.cloneDb, { createdBy: CLONE_OWNER, targetType: 'users', payload: { kind: 'text', text: 'hello clone', entities: [] }, progressChatId: null }).then((j) => j.id);
  const stub = stubFetch([['/sendMessage', { ok: true, result: { message_id: 1 } }]]);
  try {
    await runCloneBroadcastJobs(made.ctx);
    const job = await made.cloneDb.first('SELECT status FROM broadcast_jobs WHERE id = ?', [jobId]);
    assert.equal(job.status, 'completed');
  } finally { stub.restore(); }
});

test('an unapproved clone has its queued jobs cancelled by the cron', async () => {
  const made = await setup();
  await made.cloneDb.execute("INSERT INTO users (telegram_user_id, first_name, created_at, updated_at) VALUES (9102, 'U', 1, 1)");
  const job = await createJob(made.cloneDb, { createdBy: CLONE_OWNER, targetType: 'users', payload: { kind: 'text', text: 'x', entities: [] }, progressChatId: null });
  await runCloneBroadcastJobs(made.ctx);
  const row = await made.cloneDb.first('SELECT status FROM broadcast_jobs WHERE id = ?', [job.id]);
  assert.equal(row.status, 'cancelled');
});

test('/allbroadcast: only the clones the Main Owner selects get the broadcast', async () => {
  const made = await setup();
  const second = await insertClone(made.db, {
    owner_user_id: 5151, bot_id: 5550011, bot_username: 'other', bot_name: 'Other',
    token_enc: await encryptSecret(KEY, '5550011:tok'), db_url: 'libsql://other', db_token_enc: await encryptSecret(KEY, 'dbtok-long-enough-999999'),
    webhook_secret_enc: await encryptSecret(KEY, 's2'), status: 'running',
  });
  await updateClone(made.db, made.id, { broadcast_approved: 1 });
  await updateClone(made.db, second, { broadcast_approved: 1 });
  const otherDb = await makeDb();
  made.ctx.cloneDbFactory = (url) => (url === 'libsql://other' ? otherDb : made.cloneDb);
  await made.db.execute("INSERT INTO users (telegram_user_id, first_name, created_at, updated_at) VALUES (9201, 'A', 1, 1)");
  await broadcastCommand(made.ctx, privateMsg(OWNER, '/broadcast users hello'), 'users hello', { name: 'broadcast', argsStart: 10 });
  const preview = made.tg.calls.filter((c) => c.method === 'sendMessage').at(-1);
  const pickBtn = preview.params.reply_markup.inline_keyboard.flat().find((b) => /^bc:pick:[\w-]+:pin$/.test(b.callback_data));
  const pendingId = pickBtn.callback_data.split(':')[2];
  const click = (data) => { const q = cbq(OWNER, { chat: { id: OWNER, type: 'private' }, message_id: 8 }, data); return broadcastCallback(made.ctx, q, q.data.split(':')); };
  await click(`bc:pick:${pendingId}:pin`);
  await click(`bc:tg:${pendingId}:${made.id}`);   // select only the first clone
  await click(`bc:go:${pendingId}:pin:c`);
  assert.equal((await made.cloneDb.all('SELECT id FROM broadcast_jobs')).length, 1, 'the selected clone got a job');
  assert.equal((await otherDb.all('SELECT id FROM broadcast_jobs')).length, 0, 'the unselected clone got nothing');
});

test('/allbroadcast: sending with no clone selected is refused and no clone job is made', async () => {
  const made = await setup();
  await updateClone(made.db, made.id, { broadcast_approved: 1 });
  await made.db.execute("INSERT INTO users (telegram_user_id, first_name, created_at, updated_at) VALUES (9202, 'B', 1, 1)");
  await broadcastCommand(made.ctx, privateMsg(OWNER, '/broadcast users hello'), 'users hello', { name: 'broadcast', argsStart: 10 });
  const pickBtn = made.tg.calls.filter((c) => c.method === 'sendMessage').at(-1).params.reply_markup.inline_keyboard.flat().find((b) => /:pick:[\w-]+:skip$/.test(b.callback_data));
  const pendingId = pickBtn.callback_data.split(':')[2];
  const q = cbq(OWNER, { chat: { id: OWNER, type: 'private' }, message_id: 8 }, `bc:go:${pendingId}:skip:c`);
  await broadcastCallback(made.ctx, q, q.data.split(':'));
  assert.equal((await made.cloneDb.all('SELECT id FROM broadcast_jobs')).length, 0);
});
