import test from 'node:test';
import assert from 'node:assert/strict';
import { extractButtons, formatParseErrors, parseButtons, parseButtonBody } from '../src/keyboards/buttonParser.js';
import { rowsToReplyMarkup } from '../src/keyboards/inlineKeyboard.js';
import { makeDb } from './helpers/fakeDb.js';

test('Rule 1: URL button with nested parentheses in the label', () => {
  const r = parseButtons('(Carry On Jatta (2012) 480p. - https://t.me/c/3528920896/8719)');
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows, [[{ text: 'Carry On Jatta (2012) 480p.', url: 'https://t.me/c/3528920896/8719' }]]);
});

test('Rule 2: "|" puts buttons in the same row', () => {
  const r = parseButtons('(Carry On Jatta (2012) 480p. - https://t.me/c/3528920896/8719) | (Carry On Jatta (2012) 720p. - https://t.me/c/3528920896/8720)');
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].length, 2);
  assert.equal(r.rows[0][1].text, 'Carry On Jatta (2012) 720p.');
  assert.equal(r.rows[0][1].url, 'https://t.me/c/3528920896/8720');
});

test('Rule 3: every new line is a new row, order preserved', () => {
  const r = parseButtons('(Button 1 - https://example.com/1) | (Button 2 - https://example.com/2)\n(Button 3 - https://example.com/3) | (Button 4 - https://example.com/4)');
  assert.deepEqual(r.rows.map((row) => row.map((b) => b.text)), [['Button 1', 'Button 2'], ['Button 3', 'Button 4']]);
});

test('Rule 4: plain text on the right is a callback button', () => {
  const r = parseButtons('(Show Information - This is a callback message)');
  assert.deepEqual(r.rows, [[{ text: 'Show Information', callback: 'This is a callback message' }]]);
});

test('Rule 5: mixed URL and callback buttons', () => {
  const r = parseButtons('(Open Telegram - https://telegram.org) | (Show Details - This is a callback message)\n(Visit Website - https://example.com)');
  assert.equal(r.ok, true);
  assert.equal(r.rows[0][0].url, 'https://telegram.org');
  assert.equal(r.rows[0][1].callback, 'This is a callback message');
  assert.equal(r.rows[1][0].url, 'https://example.com');
});

test('hyphens inside labels and callback text are handled', () => {
  assert.deepEqual(parseButtonBody('Spider-Man - https://a.com'), { button: { text: 'Spider-Man', url: 'https://a.com' } });
  assert.deepEqual(parseButtonBody('Info - Episode 1 - 12 eps'), { button: { text: 'Info', callback: 'Episode 1 - 12 eps' } });
  assert.deepEqual(parseButtonBody('A - B - https://x.com/y'), { button: { text: 'A - B', url: 'https://x.com/y' } });
});

test('URLs containing parentheses stay intact', () => {
  const r = parseButtons('(Wiki - https://en.wikipedia.org/wiki/Foo_(bar))');
  assert.equal(r.rows[0][0].url, 'https://en.wikipedia.org/wiki/Foo_(bar)');
});

test('malformed definitions are rejected with clear messages', () => {
  const cases = [
    ['(No separator here)', /missing " - "/],
    ['(Label - https://exa mple.com)', null],
    ['(Label - http://)', /not a valid http/],
    ['(Label - example.com)', /no http/],
    ['(Unclosed - https://a.com', /unbalanced/],
    ['(A - https://a.com) (B - https://b.com)', /missing "\|"/],
    ['(A - https://a.com) |', /ends with/],
    ['| (A - https://a.com)', /cannot start/],
    ['(A - https://a.com) | | (B - hi)', /two "\|"/],
    ['stray text (A - https://a.com)', /outside/],
    [' - https://a.com)', null],
    ['( - https://a.com)', /label is empty/],
    ['(Label - )', /missing|empty/],
  ];
  for (const [input, re] of cases) {
    const r = parseButtons(input);
    if (re) { assert.equal(r.ok, false, input); assert.match(formatParseErrors(r.errors), re, input); }
    else assert.equal(r.ok, false, input);
  }
});

test('callback text longer than Telegram allows is rejected', () => {
  const r = parseButtons(`(Long - ${'x'.repeat(201)})`);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /200/);
});

test('limits: too many buttons per row / in total', () => {
  const row = Array.from({ length: 9 }, (_, i) => `(B${i} - https://a.com/${i})`).join(' | ');
  assert.equal(parseButtons(row).ok, false);
  const many = Array.from({ length: 101 }, (_, i) => `(B${i} - https://a.com/${i})`).join('\n');
  assert.equal(parseButtons(many).ok, false);
});

test('blank lines are ignored, empty input is an error', () => {
  assert.equal(parseButtons('(A - https://a.com)\n\n(B - hi)').rows.length, 2);
  assert.equal(parseButtons('   ').ok, false);
});

test('extractButtons only treats a trailing block of button-looking lines as buttons', () => {
  const t = 'Hello world (see note)\nA normal line (with brackets)\n\n(Open - https://a.com) | (Info - hello)\n(More - https://b.com)';
  const r = extractButtons(t);
  assert.equal(r.found, true);
  assert.equal(r.ok, true);
  assert.equal(t.slice(0, r.textEnd), 'Hello world (see note)\nA normal line (with brackets)');
  assert.equal(r.rows.length, 2);
});

test('ordinary parenthesised text is never turned into buttons', () => {
  for (const t of ['Just text', 'Price (approx) is 5 - 10 dollars', '(a note without separator)', 'Call me (maybe)']) {
    assert.equal(extractButtons(t).found, false, t);
  }
});

test('extractButtons reports malformed button lines instead of silently dropping them', () => {
  const r = extractButtons('Text\n(Broken - https://exa mple.com) | (X)');
  assert.equal(r.found, true);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});

test('rowsToReplyMarkup creates safe, stable callback ids and persists the text', async () => {
  const db = await makeDb();
  const rows = parseButtons('(Info - Hello there) | (Link - https://a.com)').rows;
  const a = await rowsToReplyMarkup(db, rows);
  const b = await rowsToReplyMarkup(db, rows);
  const cb = a.inline_keyboard[0][0].callback_data;
  assert.match(cb, /^cb:[a-f0-9]{20}$/);
  assert.ok(new TextEncoder().encode(cb).length <= 64);
  assert.equal(cb, b.inline_keyboard[0][0].callback_data, 'same text -> same id');
  assert.equal(a.inline_keyboard[0][1].url, 'https://a.com');
  assert.equal((await db.first('SELECT text FROM button_callbacks WHERE id = ?', [cb])).text, 'Hello there');
  assert.equal(await db.value('SELECT COUNT(*) FROM button_callbacks'), 1);
});
