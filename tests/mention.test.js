import test from 'node:test';
import assert from 'node:assert/strict';
import { processUpdate } from '../src/core/webhook.js';
import { addSudoUser } from '../src/database/roles.js';
import { groupMsg, makeCtx, update, OWNER } from './helpers/fakes.js';
import { mentionOf } from '../src/features/groupmgmt/mention.js';

const G = -100500;
const seen = (f) => f.db.all('SELECT user_id, left_at FROM group_members WHERE chat_id = ? ORDER BY user_id', [G]);

test('members: people who speak in a group are recorded; bots are not; a leaver is no longer mentioned', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ message: groupMsg(G, 5, 'hi') }));
  await processUpdate(f.ctx, update({ message: groupMsg(G, 6, 'hello') }));
  await processUpdate(f.ctx, update({ message: { ...groupMsg(G, 7, ''), from: { id: 7, is_bot: true, first_name: 'Bot' } } }));
  assert.deepEqual((await seen(f)).map((r) => r.user_id), [5, 6]);
  await processUpdate(f.ctx, update({ message: { ...groupMsg(G, 6, ''), left_chat_member: { id: 6, first_name: 'Leaver' } } }));
  const left = (await seen(f)).find((r) => r.user_id === 6);
  assert.ok(left.left_at, 'marked as left, kept as history');
});

test('/all: owner mentions known members in a reply, keeping the reply context', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ message: groupMsg(G, 5, 'hi') }));
  await processUpdate(f.ctx, update({ message: groupMsg(G, 6, 'hello') }));
  f.tg.reset();
  const cmd = { ...groupMsg(G, OWNER, '/all'), reply_to_message: { message_id: 42, chat: { id: G, type: 'supergroup' }, text: 'Meeting at 6' } };
  await processUpdate(f.ctx, update({ message: cmd }));
  const sent = f.tg.sent('sendMessage').find((c) => /Attention everyone/.test(c.params.text));
  assert.ok(sent, 'mention message sent');
  assert.match(sent.params.text, /tg:\/\/user\?id=5/);
  assert.match(sent.params.text, /tg:\/\/user\?id=6/);
  assert.equal(sent.params.reply_parameters?.message_id, 42, 'replies to the replied-to message');
});

test('/all: a normal member is refused', async () => {
  const f = await makeCtx();
  await processUpdate(f.ctx, update({ message: groupMsg(G, 5, 'hi') }));
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: groupMsg(G, 5, '/all') }));
  assert.equal(f.tg.sent('sendMessage').filter((c) => /Attention everyone/.test(c.params.text)).length, 0);
});

test('/atag: a sudo moderator mentions only the administrators, even those without usernames', async () => {
  const f = await makeCtx();
  await addSudoUser(f.db, 88, OWNER);
  f.tg.admins.set(G, [{ user: { id: 9, first_name: 'Asha', is_bot: false }, status: 'administrator' }]);
  await processUpdate(f.ctx, update({ message: groupMsg(G, 5, 'chatter') }));
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: groupMsg(G, 88, '/atag') }));
  const sent = f.tg.sent('sendMessage').find((c) => /Attention admins/.test(c.params.text));
  assert.ok(sent, 'admin mention message sent');
  assert.match(sent.params.text, /tg:\/\/user\?id=9/);
  assert.doesNotMatch(sent.params.text, /tg:\/\/user\?id=5/, 'ordinary members are not mentioned');
});

test('mentionOf: username when present, otherwise a text mention by id', () => {
  assert.equal(mentionOf({ user_id: 3, username: 'rahul_k', first_name: 'Rahul' }), '@rahul_k');
  assert.match(mentionOf({ user_id: 3, username: null, first_name: 'A<b>' }), /<a href="tg:\/\/user\?id=3">A&lt;b&gt;<\/a>/);
});
