import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, stubFetch } from './helpers/fakes.js';
import { makeDb } from './helpers/fakeDb.js';
import { encryptSecret } from '../src/core/cloneCrypto.js';
import { insertClone } from '../src/database/clones.js';
import { usageOf, overallUsage, pct } from '../src/features/clones/usage.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const DAY = 86400;
const NOW = 1_800_000_000;

async function addUsers(db, lastSeenList) {
  let n = 1000;
  for (const seen of lastSeenList) {
    await db.execute('INSERT INTO users (telegram_user_id, first_name, created_at, updated_at, last_seen_at) VALUES (?, ?, 1, 1, ?)', [++n, 'U', seen]);
  }
}

test('usage of one bot: daily, weekly and monthly active shares', async () => {
  const db = await makeDb();
  // 3 users: one seen 1 hour ago, one 3 days ago, one 40 days ago
  await addUsers(db, [NOW - 3600, NOW - 3 * DAY, NOW - 40 * DAY]);
  const u = await usageOf(db, NOW);
  assert.deepEqual([u.daily.active, u.daily.total], [1, 3]);
  assert.deepEqual([u.weekly.active, u.weekly.total], [2, 3]);
  assert.deepEqual([u.monthly.active, u.monthly.total], [2, 3]);
  assert.equal(pct(u.daily.active, u.daily.total), 33);
  assert.equal(pct(u.weekly.active, u.weekly.total), 67);
  assert.equal(pct(0, 0), 0, 'no users gives 0, not a division error');
});

test('overall usage adds the main bot and every running clone', async () => {
  const { ctx, db } = await makeCtx({ env: { CLONE_ENCRYPTION_KEY: KEY } });
  ctx.config.cloneKey = KEY;
  await addUsers(db, [NOW - 60, NOW - 60, NOW - 60]); // main: 3 of 3 active
  const cloneDb = await makeDb();
  await addUsers(cloneDb, [NOW - 60, NOW - 40 * DAY]); // clone: 1 of 2 active (daily)
  ctx.cloneDbFactory = () => cloneDb;
  await insertClone(db, {
    owner_user_id: 4242, bot_id: 5550031, bot_username: 'c1', bot_name: 'C1',
    token_enc: await encryptSecret(KEY, '5550031:tok'), db_url: 'libsql://c1', db_token_enc: await encryptSecret(KEY, 'dbtok-long-enough-123456'),
    webhook_secret_enc: await encryptSecret(KEY, 's'), status: 'running',
  });
  const r = await overallUsage(ctx, NOW);
  assert.deepEqual([r.totals.daily.active, r.totals.daily.total], [4, 5]);
  assert.equal(pct(r.totals.daily.active, r.totals.daily.total), 80);
  assert.equal(r.clones.length, 1);
  assert.equal(r.unavailable, 0);
});

test('a clone database that is not set up yet is set up and then counted, not guessed', async () => {
  const { ctx, db } = await makeCtx({ env: { CLONE_ENCRYPTION_KEY: KEY } });
  ctx.config.cloneKey = KEY;
  const oldDb = await makeDb({ migrate: false });
  ctx.cloneDbFactory = () => oldDb;
  await insertClone(db, {
    owner_user_id: 4243, bot_id: 5550032, bot_username: 'c2', bot_name: 'C2',
    token_enc: await encryptSecret(KEY, '5550032:tok'), db_url: 'libsql://c2', db_token_enc: await encryptSecret(KEY, 'dbtok-long-enough-654321'),
    webhook_secret_enc: await encryptSecret(KEY, 's'), status: 'running',
  });
  const r = await overallUsage(ctx, NOW);
  assert.equal(r.unavailable, 0, 'the old clone database was readable after migration');
  assert.equal(r.clones.length, 1);
});
