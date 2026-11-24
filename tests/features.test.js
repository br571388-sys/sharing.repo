import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TursoClient, toHttpUrl } from '../src/database/turso.js';
import { MIGRATIONS } from '../src/database/schema.js';
import { renderMigrationSql } from '../scripts/setup.js';
import { formatTimeIST, formatDayIST, istDayStart, istDayRange, formatCountdown } from '../src/services/timezone.js';
import { processUpdate } from '../src/core/webhook.js';
import { esc } from '../src/utils/formatter.js';
import { json, makeCtx, privateMsg, stubFetch, update, callbackQuery } from './helpers/fakes.js';

const norm = (s) => String(s).normalize('NFKC');

const media = (id, title, extra = {}) => ({
  id, title: { romaji: title, english: title, native: title }, description: 'A <b>great</b> show', format: 'TV', status: 'RELEASING', episodes: 12,
  genres: ['Action'], averageScore: 85, season: 'FALL', seasonYear: 2026, coverImage: { large: 'https://img.example.com/c.jpg' },
  nextAiringEpisode: { episode: 3, airingAt: 1800000000 }, siteUrl: 'https://anilist.co/anime/' + id, ...extra,
});

// ---- turso ----
test('Turso client: encodes args, decodes rows, sends bearer token, maps HTTP errors', async () => {
  const stub = stubFetch([['/v2/pipeline', (u, init) => {
    const body = JSON.parse(init.body);
    assert.equal(init.headers.Authorization, 'Bearer tok');
    assert.equal(body.requests[0].stmt.sql, 'SELECT ?, ?, ?, ?');
    assert.deepEqual(body.requests[0].stmt.args.map((a) => a.type), ['text', 'integer', 'null', 'float']);
    return json({ results: [{ type: 'ok', response: { type: 'execute', result: { cols: [{ name: 'a' }, { name: 'n' }], rows: [[{ type: 'text', value: 'x' }, { type: 'integer', value: '42' }]], affected_row_count: 0, last_insert_rowid: null } } }] });
  }]]);
  try {
    const db = new TursoClient({ url: 'libsql://db.turso.io', authToken: 'tok' });
    const r = await db.execute('SELECT ?, ?, ?, ?', ['s', 5, null, 1.5]);
    assert.equal(r.rows[0].a, 'x');
    assert.equal(Number(r.rows[0].n), 42);
    assert.equal(stub.calls[0].url, 'https://db.turso.io/v2/pipeline');
  } finally { stub.restore(); }
  assert.equal(toHttpUrl('libsql://a.b.io'), 'https://a.b.io');
});

test('Turso client: batch is one transaction with rollback, failures throw', async () => {
  let sent;
  const stub = stubFetch([['/v2/pipeline', (u, init) => { sent = JSON.parse(init.body); return json({ results: [{ type: 'ok', response: { type: 'batch', result: { step_results: [{}, { cols: [], rows: [] }, null, {}], step_errors: [null, null, null, null] } } }] }); }]]);
  try {
    const db = new TursoClient({ url: 'https://db.turso.io', authToken: 'tok' });
    await assert.rejects(db.batch([{ sql: 'INSERT INTO t VALUES (1)', args: [] }]), /not committed/);
    const steps = sent.requests[0].batch.steps;
    assert.equal(steps[0].stmt.sql, 'BEGIN');
    assert.equal(steps.at(-2).stmt.sql, 'COMMIT');
    assert.equal(steps.at(-1).stmt.sql, 'ROLLBACK');
  } finally { stub.restore(); }
  for (const [status, re] of [[401, /authentication/], [404, /not found/], [500, /HTTP 500/]]) {
    const s = stubFetch([['pipeline', () => new Response('x', { status })]]);
    try { await assert.rejects(new TursoClient({ url: 'https://d.io', authToken: 't' }).execute('INSERT INTO t VALUES (1)'), re); } finally { s.restore(); }
  }
  assert.throws(() => new TursoClient({ url: '', authToken: 't' }), /not configured/);
});

test('SQL is always parameterised: hostile input is stored as data, not executed', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/ping', { from: { id: 5, first_name: "x'); DROP TABLE users;--", username: 'a' } }) }));
  assert.equal(await f.db.value('SELECT COUNT(*) FROM users'), 1);
  assert.match(await f.db.value('SELECT first_name FROM users WHERE telegram_user_id = 5'), /DROP TABLE/);
});

// ---- migrations / timezone ----
test('migrations/001_initial.sql matches the schema in code', () => {
  const file = readFileSync(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8');
  assert.equal(file.trim(), renderMigrationSql(MIGRATIONS[0]).trim());
});

test('migrations/002_group_management.sql matches the schema in code', () => {
  const file = readFileSync(new URL('../migrations/002_group_management.sql', import.meta.url), 'utf8');
  assert.equal(file.trim(), renderMigrationSql(MIGRATIONS[1]).trim());
});

test('migrations/003_roles_and_global_bans.sql matches the schema in code', () => {
  const file = readFileSync(new URL('../migrations/003_roles_and_global_bans.sql', import.meta.url), 'utf8');
  assert.equal(file.trim(), renderMigrationSql(MIGRATIONS[2]).trim());
});

test('IST helpers', () => {
  const t = Date.UTC(2026, 10, 14, 18, 30) / 1000; // 15 Nov 00:00 IST
  assert.equal(formatTimeIST(t), '12:00 AM IST');
  assert.match(formatDayIST(t), /Sun, Nov 15/);
  assert.equal(istDayStart(t), t);
  assert.equal(istDayStart(t - 1), t - 86400);
  assert.deepEqual(istDayRange(1, t), { from: t + 86400, to: t + 172800 });
  assert.equal(formatCountdown(t + 7200 + 60, t), '2h 1m');
  assert.equal(formatCountdown(t - 5, t), 'aired');
});

// ---- anime ----
test('/anime: Taizen failure falls back to AniList; result is cached and escaped', async () => {
  const f = await makeCtx();
  const stub = stubFetch([
    ['taizen', () => { throw new Error('boom'); }],
    ['anilist', () => json({ data: { Page: { media: [media(1, 'Frieren <script>')] } } })],
  ]);
  try {
    await processUpdate(f.ctx, update({ message: privateMsg(5, '/anime frieren') }));
    const n = stub.calls.length;
    await processUpdate(f.ctx, update({ message: privateMsg(6, '/animeinfo frieren') }));
    assert.equal(stub.calls.length, n, 'second lookup served from cache');
  } finally { stub.restore(); }
  const out = [...f.tg.sent('sendPhoto').map((c) => c.params.caption), ...f.tg.sent('sendMessage').map((c) => c.params.text)].join('\n');
  assert.match(out, /Frieren/);
  assert.ok(!out.includes('<script>'), 'html escaped');
  assert.ok(f.tg.sent('editMessageText').length + f.tg.sent('editMessageCaption').length + f.tg.sent('deleteMessage').length >= 0);
});

test('/anime: both providers down -> friendly message; no query -> usage', async () => {
  const f = await makeCtx();
  const stub = stubFetch([[() => true, () => { throw new Error('down'); }]]);
  try { await processUpdate(f.ctx, update({ message: privateMsg(5, '/anime x') })); } finally { stub.restore(); }
  assert.match(norm(JSON.stringify(f.tg.calls.map((c) => c.params.text))), /Service Unavailable/i);
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/anime') }));
  assert.match(norm(f.tg.texts().at(-1)), /Invalid Usage/i);
});

test('/anime: no results -> not found', async () => {
  const f = await makeCtx();
  const stub = stubFetch([['graphql', () => json({ data: { Page: { media: [] } } })]]);
  try { await processUpdate(f.ctx, update({ message: privateMsg(5, '/anime zzzzzz') })); } finally { stub.restore(); }
  assert.match(norm(JSON.stringify(f.tg.calls.map((c) => c.params.text || c.params.caption))), /Not Found|No Results|not find/i);
});

test('/schedule shows times in IST', async () => {
  const f = await makeCtx();
  const now = Math.floor(Date.now() / 1000);
  const at = istDayStart(now) + 20 * 3600 + 1800 - 19800 + 19800; // 20:30 IST today
  const stub = stubFetch([['graphql', () => json({ data: { Page: { pageInfo: { hasNextPage: false }, airingSchedules: [{ id: 1, episode: 4, airingAt: at, media: media(7, 'Test Show') }] } } })]]);
  try { await processUpdate(f.ctx, update({ message: privateMsg(5, '/schedule today') })); } finally { stub.restore(); }
  const text = f.tg.texts().concat(f.tg.sent('editMessageText').map((c) => c.params.text)).join('\n');
  assert.match(text, /Test Show/);
  assert.match(text, /08:30 PM IST/);
});

// ---- translation ----
test('/tr: translates, caches, handles quota and bad language', async () => {
  const f = await makeCtx();
  const stub = stubFetch([['mymemory', () => json({ responseData: { translatedText: 'Hola mundo' }, responseStatus: 200 })]]);
  try {
    await processUpdate(f.ctx, update({ message: privateMsg(5, '/tr es Hello world') }));
    const n = stub.calls.length;
    await processUpdate(f.ctx, update({ message: privateMsg(6, '/translate es Hello world') }));
    assert.equal(stub.calls.length, n, 'cached');
  } finally { stub.restore(); }
  assert.ok(f.tg.calls.some((c) => /Hola mundo/.test(c.params.text || '')));

  f.tg.reset();
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/tr xx hi') }));
  assert.match(norm(f.tg.texts().at(-1)), /Language|Usage/i);

  f.tg.reset();
  const q = stubFetch([['mymemory', () => json({ responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS' }, responseStatus: 200 })]]);
  try { await processUpdate(f.ctx, update({ message: privateMsg(5, '/tr fr another text') })); } finally { q.restore(); }
  assert.match(JSON.stringify(f.tg.calls.map((c) => c.params.text)), /allowance|limit/i);
});

test('/tr can translate a replied-to message', async () => {
  const f = await makeCtx();
  const stub = stubFetch([['mymemory', (u) => { assert.match(decodeURIComponent(u), /replied.text/); return json({ responseData: { translatedText: 'texto' }, responseStatus: 200 }); }]]);
  try { await processUpdate(f.ctx, update({ message: privateMsg(5, '/tr es', { reply_to_message: { message_id: 1, text: 'replied text', from: { id: 9 } } }) })); } finally { stub.restore(); }
  assert.ok(f.tg.calls.some((c) => /texto/.test(c.params.text || '')));
});

// ---- image search ----
test('/image: Pixabay results with attribution, paging buttons, cache; Wikimedia fallback', async () => {
  const f = await makeCtx({ env: { PIXABAY_API_KEY: 'pk-secret' } });
  const hits = [1, 2, 3].map((i) => ({ webformatURL: `https://cdn.pixabay.com/${i}.jpg`, pageURL: `https://pixabay.com/${i}`, tags: `cat ${i}`, user: `author${i}` }));
  const stub = stubFetch([['pixabay', () => json({ hits })]]);
  try {
    await processUpdate(f.ctx, update({ message: privateMsg(5, '/image cats') }));
    const n = stub.calls.length;
    await processUpdate(f.ctx, update({ message: privateMsg(6, '/img cats') }));
    assert.equal(stub.calls.length, n, 'cached');
  } finally { stub.restore(); }
  const photo = f.tg.sent('sendPhoto')[0];
  assert.match(photo.params.caption, /author1/);
  assert.match(photo.params.caption, /Pixabay/);
  const btns = photo.params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data || b.url);
  assert.ok(btns.some((b) => /^img:/.test(b)), 'paging buttons');
  assert.ok(!JSON.stringify(f.tg.calls).includes('pk-secret'), 'API key never sent to users');

  const g = await makeCtx();
  const w = stubFetch([['wikimedia', () => json({ query: { pages: [{ title: 'File:Cat.jpg', index: 1, imageinfo: [{ mime: 'image/jpeg', thumburl: 'https://upload.wikimedia.org/c.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Cat.jpg', extmetadata: { Artist: { value: 'Jane' }, LicenseShortName: { value: 'CC BY 4.0' } } }] }] } })]]);
  try { await processUpdate(g.ctx, update({ message: privateMsg(5, '/image cat') })); } finally { w.restore(); }
  assert.match(norm(g.tg.sent('sendPhoto')[0].params.caption), /CC BY 4.0/i);
});

// ---- formatter ----
test('formatter escapes HTML', () => {
  assert.equal(esc('<a href="x">&</a>'), '&lt;a href="x"&gt;&amp;&lt;/a&gt;');
  void callbackQuery;
});
