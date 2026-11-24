import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, callbackQuery, stubFetch, OWNER } from './helpers/fakes.js';
import { makeDb } from './helpers/fakeDb.js';
import { encryptSecret } from '../src/core/cloneCrypto.js';
import { insertClone, getClone } from '../src/database/clones.js';
import { setBotSetting } from '../src/database/settings.js';
import { cloneManageCallback } from '../src/features/clones/clonesPanel.js';
import { syncGbanToClones, seedCloneBans } from '../src/features/clones/gbanSync.js';
import { createGlobalBan } from '../src/database/roles.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const allText = (tg) => tg.texts().join('\n').toLowerCase();

async function setup() {
  const made = await makeCtx({ env: { CLONE_ENCRYPTION_KEY: KEY } });
  made.ctx.config.cloneKey = KEY;
  await setBotSetting(made.db, 'public_base_url', 'https://worker.test');
  const cloneDb = await makeDb();
  made.ctx.cloneDbFactory = () => cloneDb;
  const id = await insertClone(made.db, { owner_user_id: 4242, bot_id: 5550009, bot_username: 'kid', bot_name: 'Kid', token_enc: await encryptSecret(KEY, '5550009:tok'), db_url: 'libsql://kid', db_token_enc: await encryptSecret(KEY, 'dbtok-long-enough-123456'), webhook_secret_enc: await encryptSecret(KEY, 's'), status: 'running' });
  return { ...made, cloneDb, id };
}

const cq = (from, data) => callbackQuery(from, { chat: { id: from }, message_id: 7 }, data);

test('main owner panel: non-owners are refused', async () => {
  const { ctx, db, id } = await setup();
  const q = cq(9999, `cm:s:${id}`);
  await cloneManageCallback(ctx, q, q.data.split(':'));
  assert.equal((await getClone(db, id)).status, 'running');
});

test('main owner stops a clone: status, stopped_by, owner DM, and the owner cannot resume it', async () => {
  const { ctx, db, tg, id } = await setup();
  const stub = stubFetch([['/deleteWebhook', { ok: true, result: true }], ['/setWebhook', { ok: true, result: true }], ['/getWebhookInfo', () => ({ ok: true, result: { url: 'https://worker.test/webhook/clone/' + id } })]]);
  try {
    const stop = cq(OWNER, `cm:s:${id}`);
    await cloneManageCallback(ctx, stop, stop.data.split(':'));
    const c = await getClone(db, id);
    assert.equal(c.status, 'stopped');
    assert.equal(c.stopped_by, 'main');
    assert.ok(allText(tg).includes('clone bot stopped'));
    // the clone owner tries to resume it: refused
    const { cloneCallback } = await import('../src/features/clones/clonebot.js');
    const own = cq(4242, `cl:r:${id}`);
    await cloneCallback(ctx, own, own.data.split(':'));
    assert.equal((await getClone(db, id)).status, 'stopped');
  } finally { stub.restore(); }
});

test('main owner toggles broadcast approval and the clone owner is told', async () => {
  const { ctx, db, tg, id } = await setup();
  const q = cq(OWNER, `cm:b:${id}`);
  await cloneManageCallback(ctx, q, q.data.split(':'));
  assert.equal((await getClone(db, id)).broadcast_approved, 1);
  assert.ok(allText(tg).includes('broadcast permission approved'));
});

test('limit buttons change the per-user clone limit within 1 to 20', async () => {
  const { ctx, db } = await setup();
  for (let i = 0; i < 25; i++) { const q = cq(OWNER, 'cm:L:1'); await cloneManageCallback(ctx, q, q.data.split(':')); }
  assert.equal(Number(await db.value("SELECT setting_value FROM bot_settings WHERE setting_key = 'clone_limit'", [], 0)), 20);
  const down = cq(OWNER, 'cm:L:-1');
  for (let i = 0; i < 40; i++) await cloneManageCallback(ctx, down, down.data.split(':'));
  assert.equal(Number(await db.value("SELECT setting_value FROM bot_settings WHERE setting_key = 'clone_limit'", [], 0)), 1);
});

test('dashboard and list render for the main owner', async () => {
  const { ctx, tg, id } = await setup();
  const d = cq(OWNER, 'cm:d');
  await cloneManageCallback(ctx, d, d.data.split(':'));
  const l = cq(OWNER, 'cm:l:0');
  await cloneManageCallback(ctx, l, l.data.split(':'));
  const v = cq(OWNER, `cm:v:${id}`);
  await cloneManageCallback(ctx, v, v.data.split(':'));
  assert.ok(tg.calls.some((c) => c.method === 'editMessageText'));
});

test('global bans are mirrored into every clone database and lifted there too', async () => {
  const { ctx, db, cloneDb } = await setup();
  await createGlobalBan(db, { userId: 31337, moderator: OWNER, reason: 'spam' });
  const r = await syncGbanToClones(ctx, { userId: 31337, status: 'active', moderatorId: OWNER, reason: 'spam', createdAt: 1700000000 });
  assert.deepEqual(r, { synced: 1, failed: 0 });
  assert.equal((await cloneDb.first('SELECT status FROM global_bans WHERE user_id = ?', [31337])).status, 'active');
  await syncGbanToClones(ctx, { userId: 31337, status: 'lifted', moderatorId: OWNER, createdAt: 1700000100, liftedBy: OWNER, liftedAt: 1700000100 });
  assert.equal((await cloneDb.first('SELECT status FROM global_bans WHERE user_id = ?', [31337])).status, 'lifted');
});

test('a new clone database receives the bans already active in the main database', async () => {
  const { db } = await setup();
  await createGlobalBan(db, { userId: 555, moderator: OWNER, reason: 'old' });
  await createGlobalBan(db, { userId: 556, moderator: OWNER, reason: 'older' });
  const fresh = await makeDb();
  assert.equal(await seedCloneBans(db, fresh), 2);
  assert.equal((await fresh.all('SELECT user_id FROM global_bans')).length, 2);
});


test('a main-bot gban reaches a clone: its groups get a queued ban, and the clone cron applies it', async () => {
  const { ctx, db, cloneDb } = await setup();
  await cloneDb.execute("INSERT INTO groups (telegram_chat_id, group_type, is_active, joined_at, updated_at) VALUES (-1001, 'supergroup', 1, 1700000000, 1700000000), (-1002, 'supergroup', 1, 1700000000, 1700000000)");
  await createGlobalBan(db, { userId: 777, moderator: OWNER, reason: 'spam' });
  await syncGbanToClones(ctx, { userId: 777, status: 'active', moderatorId: OWNER, reason: 'spam', createdAt: 1700000000 });
  const queued = await cloneDb.all('SELECT chat_id, status FROM global_ban_results WHERE user_id = ? ORDER BY chat_id', [777]);
  assert.deepEqual(queued.map((q) => [q.chat_id, q.status]), [[-1002, 'pending'], [-1001, 'pending']]);
  const { runCloneGbanJobs } = await import('../src/features/clones/cloneHealth.js');
  const stub = stubFetch([
    ['/getChatMember', (u, init) => ({ ok: true, result: JSON.parse(init.body).user_id === 777
      ? { status: 'member', user: { id: 777 } }
      : { status: 'administrator', can_restrict_members: true, can_delete_messages: true, user: { id: 5550009 } } })],
    ['/banChatMember', { ok: true, result: true }],
  ]);
  try {
    await runCloneGbanJobs(ctx);
    const after = await cloneDb.all('SELECT status FROM global_ban_results WHERE user_id = ?', [777]);
    assert.ok(after.every((r) => r.status === 'ok'), JSON.stringify(after));
  } finally { stub.restore(); }
});
