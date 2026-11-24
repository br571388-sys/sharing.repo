import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload } from '../src/features/broadcast/sender.js';
import { handleQueueBatch, processChunk, sweepStaleJobs, classifyFailure } from '../src/features/broadcast/queue.js';
import { createJob, getJob, jobStats } from '../src/database/broadcasts.js';
import { upsertUser } from '../src/database/users.js';
import { upsertGroup } from '../src/database/groups.js';
import { processUpdate } from '../src/core/webhook.js';
import { TelegramError } from '../src/utils/errors.js';
import { callbackQuery, groupMsg, makeCtx, privateMsg, update, OWNER } from './helpers/fakes.js';

const norm = (s) => String(s).normalize('NFKC');

async function seedRecipients(db, users = 12, groups = 2) {
  for (let i = 1; i <= users; i++) await upsertUser(db, { id: 2000 + i, first_name: `U${i}` });
  for (let i = 1; i <= groups; i++) await upsertGroup(db, { id: -3000 - i, type: 'supergroup', title: `G${i}` });
}

const textPayload = { kind: 'text', text: 'Hello everyone' };

async function runToCompletion(ctx, jobId, opts = {}) {
  let guard = 0;
  while (guard++ < 50) {
    const r = await processChunk(ctx, jobId, { sleepFn: async () => {}, ...opts });
    if (r.done) return guard;
  }
  throw new Error('job did not finish');
}

test('buildPayload: inline text with buttons keeps formatting and builds the keyboard', async () => {
  const { ctx } = await makeCtx();
  const text = '/broadcast users Hello bold world\n(Open - https://a.com) | (Info - Hi there)\n(More - https://b.com)';
  const msg = privateMsg(OWNER, text, { entities: [{ type: 'bot_command', offset: 0, length: 10 }, { type: 'bold', offset: 23, length: 4 }] });
  const r = await buildPayload(ctx, msg, '/broadcast users '.length);
  assert.equal(r.ok, true);
  assert.equal(r.payload.kind, 'text');
  assert.equal(r.payload.text, 'Hello bold world');
  assert.deepEqual(r.payload.entities, [{ type: 'bold', offset: 6, length: 4 }]);
  assert.equal(r.buttonCount, 3);
  const kb = r.payload.reply_markup.inline_keyboard;
  assert.equal(kb.length, 2);
  assert.equal(kb[0].length, 2);
  assert.equal(kb[0][0].url, 'https://a.com');
  assert.match(kb[0][1].callback_data, /^cb:/);
});

test('buildPayload: reply to media copies the message; caption buttons are extracted', async () => {
  const { ctx } = await makeCtx();
  const replied = { message_id: 77, chat: { id: OWNER, type: 'private' }, photo: [{ file_id: 'p' }], caption: 'Nice pic\n(Source - https://a.com)' };
  const msg = privateMsg(OWNER, '/broadcast all', { reply_to_message: replied });
  const r = await buildPayload(ctx, msg, '/broadcast all'.length);
  assert.equal(r.ok, true);
  // Nothing typed after the command: the replied post is copied as it is (formatting + buttons).
  assert.equal(r.payload.kind, 'copy');
  assert.equal(r.payload.from_chat_id, OWNER);
});

test('smart content: replied photo + typed text + typed buttons are combined in one payload', async () => {
  const { ctx } = await makeCtx();
  const replied = { message_id: 78, chat: { id: OWNER, type: 'private' }, photo: [{ file_id: 'ph' }], caption: 'Old caption\n(Docs - https://docs.example.com)' };
  const msg = privateMsg(OWNER, '/broadcast all New text here\n(Join - https://t.me/x)', { reply_to_message: replied });
  const r = await buildPayload(ctx, msg, '/broadcast all '.length);
  assert.equal(r.ok, true);
  assert.equal(r.payload.kind, 'media');
  assert.equal(r.payload.text, 'New text here', 'typed text wins over the replied caption');
  const urls = r.payload.reply_markup.inline_keyboard.flat().map((b) => b.url);
  assert.deepEqual(urls, ['https://docs.example.com', 'https://t.me/x'], 'buttons from both sources');
  assert.equal(r.buttonCount, 2);
});

test('buildPayload: media sent with the command as caption is the broadcast', async () => {
  const { ctx } = await makeCtx();
  const msg = privateMsg(OWNER, undefined, { text: undefined, caption: '/broadcast users Big news', photo: [{ file_id: 'x' }] });
  const r = await buildPayload(ctx, msg, '/broadcast users '.length);
  assert.equal(r.ok, true);
  assert.equal(r.payload.kind, 'media');
  assert.equal(r.payload.text, 'Big news');
});

test('buildPayload: errors are explained, empty input is flagged', async () => {
  const { ctx } = await makeCtx();
  assert.equal((await buildPayload(ctx, privateMsg(OWNER, '/broadcast users'), '/broadcast users'.length)).error, 'empty');
  const bad = await buildPayload(ctx, privateMsg(OWNER, '/broadcast users Hi\n(Broken - https://exa mple.com)'), '/broadcast users '.length);
  assert.equal(bad.ok, false);
  assert.match(bad.error.normalize('NFKC'), /Invalid Button Format/i);
  const long = await buildPayload(ctx, privateMsg(OWNER, `/broadcast x ${'a'.repeat(5000)}`), '/broadcast x '.length);
  assert.match(long.error.normalize('NFKC'), /Too Long/i);
});

test('classifyFailure', () => {
  assert.deepEqual(classifyFailure(new TelegramError('Too Many Requests', { status: 429, retryAfter: 7 }), 1), { status: 'pending', retryAfter: 7 });
  assert.equal(classifyFailure(new TelegramError('Too Many Requests', { status: 429, retryAfter: 7 }), 5).status, 'failed');
  assert.equal(classifyFailure(new TelegramError('Forbidden: bot was blocked by the user', { status: 403 }), 1).status, 'blocked');
  assert.equal(classifyFailure(new TelegramError('Bad Request: chat not found', { status: 400 }), 1).status, 'blocked');
  assert.equal(classifyFailure(new TelegramError('Bad Gateway', { status: 502 }), 1).status, 'pending');
  assert.equal(classifyFailure(new TelegramError('Bad Gateway', { status: 502 }), 3).status, 'failed');
  assert.equal(classifyFailure(new TelegramError('Bad Request: message is too long', { status: 400 }), 1).status, 'failed');
});

test('job creation snapshots recipients per target and skips blocked users / inactive groups', async () => {
  const { db } = await makeCtx();
  await seedRecipients(db, 5, 2);
  await db.execute('UPDATE users SET is_blocked = 1 WHERE telegram_user_id = 2001');
  await db.execute('UPDATE groups SET is_active = 0 WHERE telegram_chat_id = -3002');
  const users = await createJob(db, { createdBy: OWNER, targetType: 'users', payload: textPayload });
  const groups = await createJob(db, { createdBy: OWNER, targetType: 'groups', payload: textPayload });
  const all = await createJob(db, { createdBy: OWNER, targetType: 'all', payload: textPayload });
  assert.equal(users.total_recipients, 4);
  assert.equal(groups.total_recipients, 1);
  assert.equal(all.total_recipients, 5);
  assert.equal(all.status, 'queued');
});

test('a job with no recipients completes immediately', async () => {
  const { db } = await makeCtx();
  const job = await createJob(db, { createdBy: OWNER, targetType: 'users', payload: textPayload });
  assert.equal(job.status, 'completed');
});

test('broadcast runs in chunks via the queue and reaches everyone exactly once', async () => {
  const { ctx, db, tg } = await makeCtx();
  await seedRecipients(db, 12, 2);
  const job = await createJob(db, { createdBy: OWNER, targetType: 'all', payload: textPayload, progressChatId: OWNER });
  const chunks = await runToCompletion(ctx, job.id);
  assert.ok(chunks >= 3, `processed in several chunks (${chunks})`);

  const sends = tg.sent('sendMessage').filter((c) => c.params.text === 'Hello everyone');
  assert.equal(sends.length, 14);
  assert.equal(new Set(sends.map((c) => c.params.chat_id)).size, 14, 'no duplicates');
  const done = await getJob(db, job.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.successful_count, 14);
  assert.equal(done.failed_count, 0);
  assert.ok(done.completed_at);
});

test('running a finished job again never re-sends anything (dedupe)', async () => {
  const { ctx, db, tg } = await makeCtx();
  await seedRecipients(db, 6, 0);
  const job = await createJob(db, { createdBy: OWNER, targetType: 'users', payload: textPayload });
  await runToCompletion(ctx, job.id);
  const before = tg.sent('sendMessage').length;
  const again = await processChunk(ctx, job.id, { sleepFn: async () => {} });
  assert.equal(again.done, true);
  assert.equal(tg.sent('sendMessage').length, before);
});

test('rows are claimed once: two consumers cannot send the same recipient twice', async () => {
  const { ctx, db, tg } = await makeCtx();
  await seedRecipients(db, 4, 0);
  const job = await createJob(db, { createdBy: OWNER, targetType: 'users', payload: textPayload });
  await db.execute("UPDATE broadcast_jobs SET status = 'running' WHERE id = ?", [job.id]);
  await Promise.all([processChunk(ctx, job.id, { sleepFn: async () => {} }), processChunk(ctx, job.id, { sleepFn: async () => {} })]);
  const sends = tg.sent('sendMessage').filter((c) => c.params.text === 'Hello everyone');
  assert.equal(new Set(sends.map((c) => c.params.chat_id)).size, sends.length, 'no recipient received it twice');
});

test('blocked users and removed groups are recorded as failures and flagged', async () => {
  const { ctx, db, tg } = await makeCtx();
  await seedRecipients(db, 4, 1);
  tg.privateBlocked.add(2002);
  tg.failWhen((m, p) => m === 'sendMessage' && p.chat_id === -3001, new TelegramError('Forbidden: bot was kicked from the supergroup chat', { status: 403 }));
  tg.failWhen((m, p) => m === 'sendMessage' && p.chat_id === 2003, new TelegramError('Bad Request: message is too long', { status: 400 }));
  const job = await createJob(db, { createdBy: OWNER, targetType: 'all', payload: textPayload });
  await runToCompletion(ctx, job.id);

  const done = await getJob(db, job.id);
  assert.equal(done.successful_count, 2);
  assert.equal(done.failed_count, 3);
  const stats = await jobStats(db, job.id);
  assert.equal(stats.blocked, 2);
  assert.equal(await db.value('SELECT is_blocked FROM users WHERE telegram_user_id = 2002'), 1);
  assert.equal(await db.value('SELECT is_active FROM groups WHERE telegram_chat_id = -3001'), 0);
  assert.equal(await db.value('SELECT is_blocked FROM users WHERE telegram_user_id = 2003'), 0, 'other errors do not flag the user');
  const log = await db.first("SELECT error_message FROM broadcast_logs WHERE chat_id = 2003 AND job_id = ?", [job.id]);
  assert.match(log.error_message, /too long/);

  // a later broadcast skips the flagged chats
  const next = await createJob(db, { createdBy: OWNER, targetType: 'all', payload: textPayload });
  assert.equal(next.total_recipients, 3);
});

test('Telegram 429 retry_after: the recipient is retried later, never lost', async () => {
  const { ctx, db, tg } = await makeCtx();
  await seedRecipients(db, 3, 0);
  let limited = true;
  tg.failWhen((m, p) => m === 'sendMessage' && p.chat_id === 2002 && limited, new TelegramError('Too Many Requests: retry after 9', { status: 429, retryAfter: 9 }));
  const job = await createJob(db, { createdBy: OWNER, targetType: 'users', payload: textPayload });

  const first = await processChunk(ctx, job.id, { sleepFn: async () => {} });
  assert.equal(first.done, false);
  assert.equal(first.requeueIn, 10, 'waits retry_after + 1s');
  assert.equal((await jobStats(db, job.id)).pending, 1);

  limited = false;
  await runToCompletion(ctx, job.id);
  assert.equal((await getJob(db, job.id)).successful_count, 3);
});

test('transient Telegram errors are retried up to 3 attempts, then failed', async () => {
  const { ctx, db, tg } = await makeCtx();
  await seedRecipients(db, 1, 0);
  tg.failWhen((m) => m === 'sendMessage' && /Hello/.test(''), new Error('unused'));
  tg.failWhen((m, p) => m === 'sendMessage' && p.chat_id === 2001, new TelegramError('Bad Gateway', { status: 502 }));
  const job = await createJob(db, { createdBy: OWNER, targetType: 'users', payload: textPayload });
  await runToCompletion(ctx, job.id);
  const row = await db.first('SELECT delivery_status, attempts FROM broadcast_logs WHERE job_id = ?', [job.id]);
  assert.equal(row.delivery_status, 'failed');
  assert.equal(row.attempts, 3);
});

test('cancelling stops the job; already delivered messages stay counted', async () => {
  const { ctx, db, tg } = await makeCtx();
  await seedRecipients(db, 12, 0);
  const job = await createJob(db, { createdBy: OWNER, targetType: 'users', payload: textPayload });
  await processChunk(ctx, job.id, { sleepFn: async () => {} });
  await db.execute("UPDATE broadcast_jobs SET status = 'cancelled' WHERE id = ?", [job.id]);
  const sentBefore = tg.sent('sendMessage').length;
  const r = await processChunk(ctx, job.id, { sleepFn: async () => {} });
  assert.equal(r.done, true);
  assert.equal(tg.sent('sendMessage').length, sentBefore);
  assert.equal((await getJob(db, job.id)).successful_count, 5);
});

test('rows stuck in "sending" after a crash are settled as unknown and NOT re-sent', async () => {
  const { ctx, db, tg } = await makeCtx();
  await seedRecipients(db, 3, 0);
  const job = await createJob(db, { createdBy: OWNER, targetType: 'users', payload: textPayload });
  await db.execute("UPDATE broadcast_logs SET delivery_status = 'sending', updated_at = 1 WHERE chat_id = 2001");
  await runToCompletion(ctx, job.id);
  const sends = tg.sent('sendMessage').filter((c) => c.params.text === 'Hello everyone').map((c) => c.params.chat_id);
  assert.ok(!sends.includes(2001), 'possible duplicate is avoided');
  const done = await getJob(db, job.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.successful_count, 2);
  assert.equal(done.failed_count, 1);
});

test('cron sweep re-enqueues stalled jobs (a job is never lost)', async () => {
  const { ctx, db, queue } = await makeCtx();
  await seedRecipients(db, 3, 0);
  const job = await createJob(db, { createdBy: OWNER, targetType: 'users', payload: textPayload });
  await db.execute('UPDATE broadcast_jobs SET updated_at = 1 WHERE id = ?', [job.id]);
  const ids = await sweepStaleJobs(ctx);
  assert.deepEqual(ids, [job.id]);
  assert.deepEqual(queue.messages.at(-1).body, { jobId: job.id });

  // a job stuck in "preparing" is failed instead of hanging forever
  const stuck = await db.execute("INSERT INTO broadcast_jobs (created_by, target_type, message_payload, status, created_at, updated_at) VALUES (1, 'users', '{}', 'preparing', 1, 1)");
  await sweepStaleJobs(ctx);
  assert.equal(await db.value('SELECT status FROM broadcast_jobs WHERE id = ?', [stuck.lastInsertRowid]), 'failed');
});

test('queue consumer acks on success, re-enqueues itself for the next chunk, retries on crash', async () => {
  const { ctx, db, queue, env } = await makeCtx();
  await seedRecipients(db, 12, 0);
  const job = await createJob(db, { createdBy: OWNER, targetType: 'users', payload: textPayload });
  const acked = [];
  const retried = [];
  const message = { body: { jobId: job.id }, ack: () => acked.push(1), retry: (o) => retried.push(o) };
  const fastCtx = { ...ctx, env };
  const realSleep = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => realSleep(fn, Math.min(ms, 1), ...a);
  try {
    await handleQueueBatch({ messages: [message] }, fastCtx);
  } finally { globalThis.setTimeout = realSleep; }
  assert.equal(acked.length, 1);
  assert.equal(queue.messages.length, 1, 'next chunk queued');
  assert.deepEqual(queue.messages[0].body, { jobId: job.id });

  await handleQueueBatch({ messages: [{ body: { nope: 1 }, ack: () => acked.push(1), retry: () => retried.push(1) }] }, ctx);
  assert.equal(acked.length, 2, 'malformed messages are dropped');

  const brokenCtx = { ...ctx, get db() { throw new Error('db down'); } };
  await handleQueueBatch({ messages: [{ body: { jobId: job.id }, ack: () => acked.push(1), retry: (o) => retried.push(o) }] }, brokenCtx);
  assert.equal(retried.length, 1, 'crash -> queue retry');
});

test('progress message is edited and the owner gets a completion notice', async () => {
  const { ctx, db, tg } = await makeCtx();
  await seedRecipients(db, 6, 0);
  const job = await createJob(db, { createdBy: OWNER, targetType: 'users', payload: textPayload, progressChatId: OWNER });
  await db.execute('UPDATE broadcast_jobs SET progress_message_id = 555 WHERE id = ?', [job.id]);
  await runToCompletion(ctx, job.id);
  const edits = tg.sent('editMessageText').filter((c) => c.params.message_id === 555);
  assert.ok(edits.length >= 1);
  assert.match(edits.at(-1).params.text, /Broadcast Completed/);
  assert.match(edits.at(-1).params.text, /Success Rate:<\/b> 100%/);
  assert.match(norm(tg.texts().at(-1)), /Broadcast Completed/i);
});

// ---- commands end-to-end ----

test('/broadcast by a normal user is denied', async () => {
  const { ctx, db, tg, queue } = await makeCtx();
  await seedRecipients(db, 2, 0);
  await processUpdate(ctx, update({ message: privateMsg(5, '/broadcast users hi') }));
  assert.match(norm(tg.texts().join('\n')), /Access Denied/i);
  assert.equal(queue.messages.length, 0);
  assert.equal(await db.value('SELECT COUNT(*) FROM broadcast_jobs'), 0);
});

test('/broadcast in a group is refused even for the owner', async () => {
  const { ctx, tg } = await makeCtx();
  await processUpdate(ctx, update({ message: groupMsg(-3001, OWNER, '/broadcast users hi') }));
  assert.match(norm(tg.texts().join('\n')), /Private Chat Only/i);
});

test('/broadcast -> preview -> confirm creates a job and queues it', async () => {
  const { ctx, db, tg, queue } = await makeCtx();
  await seedRecipients(db, 3, 1);
  await processUpdate(ctx, update({ message: privateMsg(OWNER, '/allbroadcast Maintenance tonight\n(Status - https://status.example.com)') }));

  const preview = tg.sent('sendMessage').find((c) => c.params.text === 'Maintenance tonight');
  assert.ok(preview, 'exact preview sent to the owner');
  assert.equal(preview.params.reply_markup.inline_keyboard[0][0].url, 'https://status.example.com');
  const prompt = tg.sent('sendMessage').find((c) => /Broadcast Preview/.test(c.params.text || ''));
  assert.match(prompt.params.text, /Recipients:<\/b> 5/);
  const go = prompt.params.reply_markup.inline_keyboard[0][0].callback_data;
  assert.equal(await db.value('SELECT COUNT(*) FROM broadcast_jobs'), 0, 'nothing is created before confirmation');

  const cqMsg = { message_id: 900, chat: { id: OWNER, type: 'private' } };
  await processUpdate(ctx, update({ callback_query: callbackQuery(5, cqMsg, go) }));
  assert.equal(await db.value('SELECT COUNT(*) FROM broadcast_jobs'), 0, 'a non-owner cannot confirm');

  await processUpdate(ctx, update({ callback_query: callbackQuery(OWNER, cqMsg, go) }));
  assert.equal(await db.value('SELECT COUNT(*) FROM broadcast_jobs'), 1);
  assert.equal(queue.messages.length, 1);
  assert.match(norm(tg.sent('editMessageText').at(-1).params.text), /Broadcast In Progress/i);

  await processUpdate(ctx, update({ callback_query: callbackQuery(OWNER, cqMsg, go) }));
  assert.equal(await db.value('SELECT COUNT(*) FROM broadcast_jobs'), 1, 'confirmation is single-use');
});

test('/broadcast without a Queue binding explains what to do', async () => {
  const { ctx, db, tg } = await makeCtx({ withQueue: false });
  await seedRecipients(db, 2, 0);
  await processUpdate(ctx, update({ message: privateMsg(OWNER, '/broadcast users hi') }));
  assert.match(norm(tg.texts().join('\n')), /Queue Not Configured/i);
});

test('/announce: only group admins; posts the announcement and removes the command', async () => {
  const { ctx, tg } = await makeCtx();
  const G = -4001;
  tg.setMember(G, 31, 'administrator');
  tg.setMember(G, 32, 'member');
  await processUpdate(ctx, update({ message: groupMsg(G, 32, '/announce hello') }));
  assert.match(norm(tg.texts().join('\n')), /Access Denied/i);
  tg.reset();
  await processUpdate(ctx, update({ message: groupMsg(G, 31, '/announce pin Rules updated\n(Read - https://rules.example.com)') }));
  const sent = tg.sent('sendMessage').find((c) => c.params.text === 'Rules updated');
  assert.ok(sent);
  assert.equal(sent.params.chat_id, G);
  assert.ok(tg.last('pinChatMessage'));
  assert.ok(tg.last('deleteMessage'));
});
