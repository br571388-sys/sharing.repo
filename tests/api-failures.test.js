import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './helpers/fakes.js';
import { Telegram } from '../src/services/telegram.js';
import { dashboardStats, bumpUsage } from '../src/database/roles.js';
import { mainScreen } from '../src/features/roles/panel.js';

const failingFetch = () => async () => new Response(JSON.stringify({ ok: false, description: 'Bad Request: nope', error_code: 400 }), { status: 400 });

test('a final Telegram API failure is counted once in the usage table', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = failingFetch();
  try {
    const { db } = await makeCtx();
    const tg = new Telegram('1:x', { onFailure: () => bumpUsage(db, 'api_fail') });
    await assert.rejects(tg.call('sendMessage', { chat_id: 1, text: 'x' }, { autoRetry: false }));
    const stats = await dashboardStats(db);
    assert.equal(stats.apiFailTotal, 1);
    assert.equal(stats.apiFailToday, 1);
    assert.equal(stats.commandsTotal, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a broken failure hook never breaks the request that failed', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = failingFetch();
  try {
    const tg = new Telegram('1:x', { onFailure: () => { throw new Error('boom'); } });
    await assert.rejects(tg.call('sendMessage', { chat_id: 1, text: 'x' }, { autoRetry: false }), /Bad Request/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('dashboard shows the failed API calls row', async () => {
  const { ctx } = await makeCtx();
  const screen = await mainScreen(ctx, 'owner');
  const text = typeof screen === 'string' ? screen : screen.text;
  assert.match(text.toLowerCase(), /failed api calls/);
});
