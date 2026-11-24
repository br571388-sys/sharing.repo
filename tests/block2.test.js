import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from './helpers/fakes.js';
import { loginPage, runStatus, renderReport } from '../src/core/setup.js';

test('unauthorised visitors get an access-denied page', async () => {
  const html = await loginPage('/setup').text();
  assert.match(html, /ACCESS DENIED/);
  assert.match(html, /SETUP_SECRET/);
});

test('/status report includes the API services section', async () => {
  const { ctx } = await makeCtx();
  const report = await runStatus(ctx, new Request('https://worker.test/status'));
  const html = await renderReport(report, { title: 'Status' }).text();
  assert.match(html, /API SERVICES/);
});
