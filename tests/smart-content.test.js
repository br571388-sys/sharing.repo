import test from 'node:test';
import assert from 'node:assert/strict';
import { processUpdate } from '../src/core/webhook.js';
import { getBotSetting } from '../src/database/settings.js';
import { resolveSmartContent } from '../src/keyboards/smartContent.js';
import { OWNER, makeCtx, privateMsg, update } from './helpers/fakes.js';

test('/setwelcome: a replied photo with caption and buttons sets picture, text and buttons together', async () => {
  const f = await makeCtx();
  const replied = { message_id: 90, chat: { id: OWNER, type: 'private' }, photo: [{ file_id: 'small' }, { file_id: 'big-photo' }], caption: 'Welcome friend!\n(Docs - https://docs.example.com)' };
  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/setwelcome', { reply_to_message: replied }) }));
  assert.equal(await getBotSetting(f.db, 'welcome_image'), 'big-photo');
  assert.equal(await getBotSetting(f.db, 'welcome_caption'), 'Welcome friend!');
  assert.match(await getBotSetting(f.db, 'welcome_buttons'), /docs\.example\.com/);
});

test('smart content: a sticker can not carry a caption, so text is kept for a separate message', () => {
  const msg = privateMsg(OWNER, '/x', { reply_to_message: { message_id: 5, chat: { id: OWNER, type: 'private' }, sticker: { file_id: 'st' } } });
  const r = resolveSmartContent({ ...msg, text: '/x hello\n(Go - https://go.example)' }, { argsStart: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.mediaType, 'sticker');
  assert.equal(r.text, 'hello');
  assert.equal(r.buttons[0][0].url, 'https://go.example');
});

test('reply to an existing post: its link buttons, bold/italic/mono/link/quote formatting all carry over', async () => {
  const f = await makeCtx();
  const post = {
    message_id: 91, chat: { id: OWNER, type: 'private' },
    photo: [{ file_id: 'post-photo' }],
    caption: 'Big update\nBold and mono here\n> quoted line',
    caption_entities: [
      { type: 'bold', offset: 0, length: 10 },
      { type: 'code', offset: 19, length: 4 },
      { type: 'blockquote', offset: 25, length: 11 },
    ],
    reply_markup: { inline_keyboard: [[{ text: 'Read more', url: 'https://news.example' }, { text: 'Vote', callback_data: 'v1' }]] },
  };
  const { ctx } = await makeCtx();
  const { buildPayload } = await import('../src/features/broadcast/sender.js');
  const r = await buildPayload(ctx, privateMsg(OWNER, '/broadcast all', { reply_to_message: post }), '/broadcast all'.length);
  assert.equal(r.ok, true);
  // Bare reply: the post is copied, so every entity and every button (also callback buttons) is kept.
  assert.equal(r.payload.kind, 'copy');
  assert.equal(r.payload.message_id, 91);
  // URL buttons are set explicitly (with colour); the post's callback button is not copied (it would be dead).
  assert.deepEqual(r.payload.reply_markup.inline_keyboard, [[{ text: 'Read more', url: 'https://news.example' }]]);
  assert.equal(r.droppedCallbacks, 1);
});
