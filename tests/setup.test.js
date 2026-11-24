import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/index.js';
import { getBotSetting } from '../src/database/settings.js';
import { BOT_ID, TOKEN, json, makeCtx, privateMsg, stubFetch, update, OWNER } from './helpers/fakes.js';

const norm = (s) => String(s).normalize('NFKC');

const SETUP = 'setup-secret-very-long-1234';
const apiStubs = () => stubFetch([
  ['graphql', () => json({ data: { Page: { media: [] }, Media: null } })],
  ['mymemory', () => json({ responseData: { translatedText: 'hola' }, responseStatus: 200 })],
  ['pixabay', () => json({ hits: [] })],
  ['wikimedia', () => json({ query: { pages: [] } })],
  [() => true, () => json({}, 200)],
]);

async function hit(f, path, { method = 'GET', headers = {}, body, ip = '1.2.3.4' } = {}) {
  const req = new Request(`https://bot.example.com${path}`, { method, headers: { 'CF-Connecting-IP': ip, ...headers }, body });
  const pending = [];
  const res = await handleRequest(req, f.env, { waitUntil: (p) => pending.push(p) }, { db: f.db, tg: f.tg, botInfo: { id: BOT_ID, username: 'NobaraTestBot' } });
  await Promise.all(pending);
  return res;
}
const auth = { Authorization: `Bearer ${SETUP}` };

test('/setup without credentials shows a login form and runs nothing', async () => {
  const f = await makeCtx({ migrate: false });
  const res = await hit(f, '/setup');
  assert.match(await res.text(), /<form/);
  assert.equal(f.tg.calls.length, 0);
});

test('/setup: wrong secrets are rate limited per IP', async () => {
  const f = await makeCtx({ migrate: false });
  let last;
  for (let i = 0; i < 12; i++) last = await hit(f, '/setup', { headers: { Authorization: 'Bearer wrong-wrong-wrong' }, ip: '9.9.9.9' });
  assert.equal(last.status, 429);
  const other = await hit(f, '/setup', { headers: auth, ip: '8.8.8.8' });
  assert.notEqual(other.status, 429);
});

test('/setup: login form sets a signed HttpOnly cookie that works', async () => {
  const f = await makeCtx({ migrate: false });
  const stub = apiStubs();
  try {
    const bad = await hit(f, '/setup', { method: 'POST', body: new URLSearchParams({ secret: 'nope' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(bad.status, 401);
    assert.ok(!bad.headers.get('Set-Cookie'));
    const ok = await hit(f, '/setup', { method: 'POST', body: new URLSearchParams({ secret: SETUP }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(ok.status, 303);
    const cookie = ok.headers.get('Set-Cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    const res = await hit(f, '/setup', { headers: { Cookie: cookie.split(';')[0] } });
    assert.equal(res.status, 200);
    assert.match(await (await hit(f, '/setup', { headers: { Cookie: 'nb_setup=forged.token' } })).text(), /<form/);
    assert.equal(f.tg.sent('setWebhook').length, 1, 'only the legitimate run changed anything');
  } finally { stub.restore(); }
});

test('acceptance flow: setup replaces the old webhook directly, migrates, then /start and commands work', async () => {
  const f = await makeCtx({ migrate: false });
  f.tg.webhook = { url: 'https://old.example.com/hook', pending_update_count: 7 };
  const stub = apiStubs();
  let html;
  try {
    const res = await hit(f, '/setup', { headers: auth });
    assert.equal(res.status, 200);
    html = await res.text();
  } finally { stub.restore(); }
  assert.match(html, /SETUP COMPLETED/);
  const set = f.tg.last('setWebhook');
  assert.equal(set.params.url, 'https://bot.example.com/webhook');
  assert.equal(set.params.secret_token, 'whsecret_123');
  assert.ok(!('drop_pending_updates' in set.params) || set.params.drop_pending_updates === false);
  assert.equal(f.tg.sent('deleteWebhook').length, 0, 'never deletes the webhook');
  assert.equal(f.tg.webhook.url, 'https://bot.example.com/webhook');
  assert.ok(f.tg.sent('setMyCommands').length >= 1);
  assert.equal(await f.db.value('SELECT COUNT(*) FROM schema_migrations') > 0, true);
  // no secrets in the page
  for (const s of [TOKEN, 'turso-token-abc', 'whsecret_123', SETUP]) assert.ok(!html.includes(s), 'leaked a secret');

  // the bot now answers
  const wh = await hit(f, '/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'whsecret_123', 'Content-Type': 'application/json' }, body: JSON.stringify(update({ message: privateMsg(5, '/start') })) });
  assert.equal(wh.status, 200);
  assert.match(norm(f.tg.texts().at(-1)), /Welcome to <b>Nobara<\/b>/i);
});

test('setup is idempotent: a second run does not replace a correct webhook or duplicate data', async () => {
  const f = await makeCtx({ migrate: false });
  const stub = apiStubs();
  try {
    await hit(f, '/setup', { headers: auth });
    const calls = f.tg.sent('setWebhook').length;
    const users = await f.db.value('SELECT COUNT(*) FROM bot_settings');
    const res = await hit(f, '/setup', { headers: auth });
    const html = await res.text();
    assert.match(html, /Already Configured/);
    assert.equal(f.tg.sent('setWebhook').length, calls, 'no second setWebhook');
    assert.equal(await f.db.value('SELECT COUNT(*) FROM bot_settings'), users);
  } finally { stub.restore(); }
});

test('setup with a webhook already correct (set by someone else) is left alone when it matches', async () => {
  const f = await makeCtx({ migrate: false });
  const stub = apiStubs();
  try {
    await hit(f, '/setup', { headers: auth });
    f.tg.reset();
    await hit(f, '/setup', { headers: auth });
    assert.equal(f.tg.sent('deleteWebhook').length, 0);
  } finally { stub.restore(); }
});

test('setup with an invalid token reports failure honestly and does not touch the webhook', async () => {
  const f = await makeCtx({ migrate: false });
  f.tg.failWhen((m) => m === 'getMe', Object.assign(new Error('Unauthorized'), { status: 401 }));
  const stub = apiStubs();
  try {
    const html = await (await hit(f, '/setup', { headers: auth })).text();
    assert.match(html, /Setup Failed/);
    assert.doesNotMatch(html, /SETUP COMPLETED/);
    assert.equal(f.tg.sent('setWebhook').length, 0);
  } finally { stub.restore(); }
});

test('setup reports a Turso outage as a failure', async () => {
  const f = await makeCtx({ migrate: false });
  f.db.fail = true;
  const stub = apiStubs();
  try {
    const html = await (await hit(f, '/setup', { headers: auth })).text();
    assert.match(html, /Setup Failed/);
  } finally { stub.restore(); f.db.fail = false; }
});

test('/status is protected, never leaks secrets, and offers JSON', async () => {
  const f = await makeCtx();
  const stub = apiStubs();
  try {
    assert.match(await (await hit(f, '/status')).text(), /<form/);
    const res = await hit(f, '/status?format=json', { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.text();
    JSON.parse(body);
    for (const s of [TOKEN, 'turso-token-abc', 'whsecret_123', SETUP]) assert.ok(!body.includes(s));
  } finally { stub.restore(); }
  void OWNER; void getBotSetting;
});
