import test from 'node:test';
import assert from 'node:assert/strict';
import { processUpdate } from '../src/core/webhook.js';
import { OWNER, makeCtx, privateMsg, update } from './helpers/fakes.js';

const norm = (s) => String(s).normalize('NFKC');

test('/getid: owner and sudo only; user without username gets tg:// profile link', async () => {
  const f = await makeCtx();
  f.tg.getChat = async (id) => (id === 777001 ? { id: 777001, type: 'private', first_name: 'Asha' } : Promise.reject(new Error('chat not found')));
  await processUpdate(f.ctx, update({ message: privateMsg(55, '/getid 777001') }));
  assert.doesNotMatch(norm(f.tg.last('sendMessage')?.params.text || ''), /Asha/, 'normal users get no lookup');
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/getid 777001') }));
  const text = norm(f.tg.last('sendMessage').params.text);
  assert.match(text, /777001/);
  assert.match(text, /Asha/);
  const urls = (f.tg.last('sendMessage').params.reply_markup.inline_keyboard || []).flat().map((b) => b.url).filter(Boolean);
  assert.deepEqual(urls, ['tg://user?id=777001'], 'first try: URL button with tg://user');
  // Telegram refuses the tg:// button -> the card is resent with a callback button
  f.tg.failWhen((m, p) => m === 'sendMessage' && /tg:\/\/user/.test(JSON.stringify(p.reply_markup || {})), new Error('Bad Request: Unsupported URL'));
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/getid 777001') }));
  const cbs = (f.tg.last('sendMessage').params.reply_markup.inline_keyboard || []).flat().map((b) => b.callback_data);
  assert.ok(cbs.includes('gi:p:777001'), 'fallback: callback button');
  f.tg.failWhen(() => false, null);
  // tapping it opens the profile as a pop-up
  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: { id: 'cb1', from: { id: OWNER, first_name: 'Owner' }, data: 'gi:p:777001', message: privateMsg(OWNER, 'x').message ?? privateMsg(OWNER, 'x') } }));
  const ans = f.tg.sent('answerCallbackQuery').at(-1)?.params;
  assert.equal(ans?.url, 'tg://user?id=777001');
});

test('/getid: username gives t.me link; unknown ID gives a clear message', async () => {
  const f = await makeCtx();
  f.tg.getChat = async (id) => {
    if (id === '@durov') return { id: 1, type: 'private', first_name: 'Pavel', username: 'durov' };
    throw new Error('chat not found');
  };
  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/getid @durov') }));
  const urls = (f.tg.last('sendMessage').params.reply_markup.inline_keyboard || []).flat().map((b) => b.url);
  assert.ok(urls.includes('https://t.me/durov'));
  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/getid 999999999') }));
  assert.match(norm(f.tg.last('sendMessage').params.text), /Not Found|did not reveal/i);
});

test('/getid: private group gets a bot-made invite link only when the bot is an admin', async () => {
  const f = await makeCtx();
  f.tg.getChat = async () => ({ id: -1001234, type: 'supergroup', title: 'Secret Club' });
  f.tg.getChatMember = async () => ({ status: 'administrator', can_invite_users: true });
  f.tg.createChatInviteLink = async () => ({ invite_link: 'https://t.me/+abc123' });
  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/getid -1001234') }));
  const urls = (f.tg.last('sendMessage').params.reply_markup.inline_keyboard || []).flat().map((b) => b.url).filter(Boolean);
  assert.deepEqual(urls, ['https://t.me/+abc123']);

  f.tg.getChatMember = async () => ({ status: 'member' });
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/getid -1001234') }));
  assert.match(norm(f.tg.last('sendMessage').params.text), /Invite users/);
});
