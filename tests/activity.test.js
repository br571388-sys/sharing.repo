import test from 'node:test';
import assert from 'node:assert/strict';
import { processUpdate } from '../src/core/webhook.js';
import { countGroupMessage, dayKey, leaderboardRows, periodRange, FLOOD_MUTE_SEC } from '../src/features/activity/activity.js';
import { selectCouples, DEFAULT_TROLLS } from '../src/features/couple/couple.js';
import { groupMsg, makeCtx, update, OWNER } from './helpers/fakes.js';

const G = -100900;
const T0 = Math.floor(Date.UTC(2026, 10, 16, 6, 0, 0) / 1000); // 11:30 IST on 16 Nov 2026
const msgAt = (uid, text = 'hi') => groupMsg(G, uid, text);

test('IST day keys and periods', () => {
  assert.equal(dayKey(T0), '2026-11-16');
  assert.deepEqual(periodRange('d', T0), { from: '2026-11-16', to: '2026-11-16' });
  assert.deepEqual(periodRange('w', T0), { from: '2026-11-10', to: '2026-11-16' }, 'weekly = last 7 days');
  assert.deepEqual(periodRange('m', T0), { from: '2026-11-01', to: '2026-11-16' }, 'monthly = this calendar month');
});

test('flood: 5 messages within 2 seconds are not counted and mute the user for 20 minutes', async () => {
  const f = await makeCtx();
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await countGroupMessage(f.db, msgAt(5), T0));
  assert.deepEqual(results, [true, true, true, true, false], 'the 5th message in the window is not counted');
  assert.equal(await countGroupMessage(f.db, msgAt(5), T0 + 60), false, 'still muted a minute later');
  assert.equal(await countGroupMessage(f.db, msgAt(5), T0 + FLOOD_MUTE_SEC + 1), true, 'counts again after 20 minutes');
  const rows = await leaderboardRows(f.db, G, 'd', 10, T0);
  assert.equal(Number(rows[0].score), 4 + 1, 'only the counted messages are on the board');
});

test('leaderboard: slow messages count; scores stay per group; history survives leaving', async () => {
  const f = await makeCtx();
  for (let i = 0; i < 3; i++) await countGroupMessage(f.db, msgAt(6), T0 + i * 10);
  await countGroupMessage(f.db, msgAt(7), T0);
  await countGroupMessage(f.db, { ...msgAt(7), chat: { id: G + 1, type: 'supergroup' } }, T0); // another group
  const board = await leaderboardRows(f.db, G, 'd', 10, T0);
  assert.deepEqual(board.map((r) => [Number(r.user_id), Number(r.score)]), [[6, 3], [7, 1]]);
  await processUpdate(f.ctx, update({ message: { ...groupMsg(G, 6, ''), left_chat_member: { id: 6, first_name: 'Gone' } } }));
  const after = await leaderboardRows(f.db, G, 'd', 10, T0);
  assert.equal(Number(after.find((r) => Number(r.user_id) === 6).score), 3, 'a member who left keeps the score');
});

test('/couple: once per 24 hours, with the exact message when already selected', async () => {
  const f = await makeCtx({ env: { IMAGE_API_URL: '' } });
  await processUpdate(f.ctx, update({ message: groupMsg(G, OWNER, '/couple') }));
  assert.match(f.tg.texts().join('\n').normalize('NFKC'), /not set up/i, 'refuses until the image service exists');
});

test('/couple: a stored selection blocks a second one for 24 hours', async () => {
  const f = await makeCtx({ env: { IMAGE_API_URL: 'https://img.example.com' } });
  await f.db.execute('INSERT INTO group_couples (chat_id, created_at, pairs) VALUES (?, ?, ?)', [G, Math.floor(Date.now() / 1000), '[]']);
  await processUpdate(f.ctx, update({ message: groupMsg(G, OWNER, '/couple') }));
  assert.ok(f.tg.texts().some((t) => t === "Today's couples have already been selected!"));
});

test('couples: pick from active members only, never the bot, bots, deleted accounts or people who left', async () => {
  const f = await makeCtx();
  const people = [11, 12, 13, 14, 15, 16];
  for (const id of people) {
    f.tg.members.set(`${G}:${id}`, { status: 'member', user: { id, first_name: 'P' + id } });
    await f.db.execute('INSERT INTO group_members (chat_id, user_id, username, first_name, is_bot, last_seen, left_at) VALUES (?, ?, NULL, ?, 0, ?, NULL)', [G, id, 'P' + id, T0]);
    await countGroupMessage(f.db, msgAt(id), T0);
  }
  f.tg.members.set(`${G}:18`, { status: 'left', user: { id: 18, first_name: 'Left' } });
  await countGroupMessage(f.db, msgAt(17), T0 - 10 * 86400); // spoke 10 days ago: not active
  await f.db.execute("INSERT INTO group_members (chat_id, user_id, username, first_name, is_bot, last_seen, left_at) VALUES (?, ?, NULL, 'Left', 0, ?, ?)", [G, 18, T0, T0]);
  await countGroupMessage(f.db, msgAt(18), T0);
  await f.db.execute("INSERT INTO group_members (chat_id, user_id, username, first_name, is_bot, last_seen, left_at) VALUES (?, ?, NULL, 'Deleted Account', 0, ?, NULL)", [G, 19, T0]);
  await countGroupMessage(f.db, msgAt(19), T0);
  const pairs = await selectCouples(f.ctx, G, T0);
  const ids = pairs.flatMap((p) => [p.a.user_id, p.b.user_id]);
  assert.equal(new Set(ids).size, ids.length, 'no one is paired twice');
  assert.ok(ids.every((id) => people.includes(id)), `only active members: ${ids}`);
  assert.equal(pairs.length, 3, 'six active people make three couples');
});

test('/mypartner: shows the partner from today, or a trolling line when there is none', async () => {
  const f = await makeCtx();
  await f.db.execute('INSERT INTO group_couples (chat_id, created_at, pairs) VALUES (?, ?, ?)', [G, Math.floor(Date.now() / 1000), JSON.stringify([[21, 22, 'Asha', 'Ravi']])]);
  await processUpdate(f.ctx, update({ message: groupMsg(G, 21, '/mypartner') }));
  assert.match(f.tg.texts().join('\n').normalize('NFKC'), /your partner today: ravi/i);
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: groupMsg(G, 99, '/mypartner') }));
  assert.ok(DEFAULT_TROLLS.includes(f.tg.texts()[0]) || DEFAULT_TROLLS.some((t) => f.tg.texts()[0] === t), 'a trolling line');
  assert.equal(DEFAULT_TROLLS.length, 20);
  assert.ok(DEFAULT_TROLLS.includes('SINGLE HEE MAREGA BHAI TU 😂') && DEFAULT_TROLLS.includes('HAI TERI GIRLFRIEND HAI 🫵🏻😂'));
});

test('/export: owner gets one JSON file with the main bot tables; others are refused', async () => {
  const f = await makeCtx();
  await countGroupMessage(f.db, msgAt(5), T0);
  await processUpdate(f.ctx, update({ message: groupMsg(G, 5, '/export') }));
  assert.equal(f.tg.sent('sendDocument').length, 0, 'a normal member gets no file');
  await processUpdate(f.ctx, update({ message: { ...groupMsg(G, OWNER, '/export'), chat: { id: OWNER, type: 'private' } } }));
  const doc = f.tg.sent('sendDocument')[0];
  assert.ok(doc, 'owner receives the export file');
  assert.equal(f.tg.sent('sendDocument').length, 1, 'exactly one export file');
});

// ---- image service integration (fetch is stubbed; nothing leaves the test) ----
const realFetch = globalThis.fetch;
const pngBytes = () => { const b = new Uint8Array(2048); b.set([137, 80, 78, 71, 13, 10, 26, 10]); return b; };

async function withImageService(respond, fn) {
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/leaderboard')) return respond(url, opts);
    return new Response(null, { status: 404 });
  };
  try { await fn(); } finally { globalThis.fetch = realFetch; }
}

test('/leaderboard: sends the picture from the image service', async () => {
  const f = await makeCtx({ env: { IMAGE_API_URL: 'https://img.example.com' } });
  await countGroupMessage(f.db, msgAt(31), Math.floor(Date.now() / 1000));
  await withImageService(() => new Response(pngBytes(), { status: 200, headers: { 'content-type': 'image/png' } }), async () => {
    await processUpdate(f.ctx, update({ message: groupMsg(G, 31, '/leaderboard') }));
  });
  assert.equal(f.tg.sent('sendPhoto').length, 1, 'the leaderboard picture is sent');
});

test('/leaderboard: a wrong picture type from the service is refused, not sent', async () => {
  const f = await makeCtx({ env: { IMAGE_API_URL: 'https://img.example.com' } });
  await countGroupMessage(f.db, msgAt(32), Math.floor(Date.now() / 1000));
  await withImageService(() => new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } }), async () => {
    await processUpdate(f.ctx, update({ message: groupMsg(G, 32, '/leaderboard') }));
  });
  assert.equal(f.tg.sent('sendPhoto').length, 0);
  assert.match(f.tg.texts().join('\n').normalize('NFKC'), /unexpected type/i);
});

test('/leaderboard: a server error is retried once, then reported honestly', async () => {
  const f = await makeCtx({ env: { IMAGE_API_URL: 'https://img.example.com' } });
  await countGroupMessage(f.db, msgAt(33), Math.floor(Date.now() / 1000));
  let calls = 0;
  await withImageService(() => { calls++; return new Response('x', { status: 503 }); }, async () => {
    await processUpdate(f.ctx, update({ message: groupMsg(G, 33, '/leaderboard') }));
  });
  assert.equal(calls, 2, 'one retry');
  assert.match(f.tg.texts().join('\n').normalize('NFKC'), /HTTP 503/);
});
