import test from 'node:test';
import assert from 'node:assert/strict';
import { processUpdate } from '../src/core/webhook.js';
import { box } from '../src/ui/design.js';
import { groupMsg, makeCtx, update } from './helpers/fakes.js';

test('/start in a group: welcome card with only a "Start in DM" button', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ message: groupMsg(-100500, 5, '/start') }));
  const call = f.tg.sent('sendPhoto').at(-1) || f.tg.sent('sendMessage').at(-1);
  assert.ok(call, 'a welcome message was sent');
  const rows = call.params.reply_markup.inline_keyboard;
  assert.equal(rows.length, 1, 'only one row of buttons');
  assert.equal(rows[0].length, 1, 'only one button');
  assert.match(rows[0][0].text.normalize('NFKC'), /START IN DM/i, 'label is the Start in DM button (block style)');
  assert.match(rows[0][0].url, /^https:\/\/t\.me\/.+\?start=start$/);
});

test('headings are quotation blocks (no frame lines)', () => {
  const b = box('📚', 'Help');
  assert.match(b, /^<blockquote>📚 .+<\/blockquote>$/);
  assert.doesNotMatch(b, /━|╭|╰/);
});
