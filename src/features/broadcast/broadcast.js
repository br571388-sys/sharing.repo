// /broadcast, /allbroadcast, /broadcaststatus (owner) and /announce (group admins).
//
// Owner flow: command -> preview of the exact message -> [Send Now] / [Cancel] -> job is created, the recipient
// list is snapshotted and the work is handed to the queue. Nothing is sent from inside the webhook request.

import { buildPayload, sendPayload } from './sender.js';
import { enqueueJob } from './queue.js';
import { renderProgress, progressKeyboard } from './progress.js';
import { countRecipients, createJob, getJob, jobStats, markProgressMessage, recentJobs, setJobStatus } from '../../database/broadcasts.js';
import { createPending, takePending, getPending, updatePendingPayload } from '../../database/state.js';
import { btn, markup } from '../../keyboards/inlineKeyboard.js';
import { canBroadcast } from '../../core/captains.js';
import { esc, field, messages } from '../../utils/formatter.js';
import { formatNumber } from '../../utils/helpers.js';
import { shiftWord } from '../../utils/command.js';
import { reply, safeEdit } from '../../handlers/helpers.js';
import { BUTTON_FORMAT_HELP } from '../../keyboards/buttonParser.js';
import { isMessageNotModified } from '../../services/telegram.js';
import { approvedCloneList, createCloneJobs, CLONE_PAYLOAD_KINDS } from '../clones/cloneBroadcast.js';

const TARGET_WORDS = { users: 'users', user: 'users', groups: 'groups', group: 'groups', all: 'all', both: 'all' };
const TARGET_LABEL = { users: '👤 All registered users', groups: '👥 All registered groups', all: '👤👥 All users and groups' };

const usage = () => messages.usage(
  ['/broadcast [users|groups|all] <text>', '/broadcast [users|groups|all] (reply to any message)', '/allbroadcast <text> (users + groups)'],
  ['/broadcast users Server maintenance tonight at 10 PM'],
  `Add button rows under the text:\n${BUTTON_FORMAT_HELP}\n\nReply to a photo, video, document… to broadcast media with its caption.`,
);

export async function broadcastCommand(ctx, msg, args, cmd) {
  if (msg.chat.type !== 'private') return reply(ctx, msg, messages.privateOnly());

  let target = cmd.name === 'allbroadcast' ? 'all' : 'users';
  let contentStart = cmd.argsStart;
  if (cmd.name !== 'allbroadcast') {
    const { word, rest } = shiftWord(args);
    const t = TARGET_WORDS[word.toLowerCase()];
    if (t) { target = t; contentStart = cmd.argsStart + (args.length - rest.length); }
  }

  const built = await buildPayload(ctx, msg, contentStart);
  if (!built.ok) return reply(ctx, msg, built.error === 'empty' ? usage() : built.error);

  if (ctx.clone && !ctx.clone.broadcastApproved) {
    return reply(ctx, msg, messages.warning('Not Approved', "Broadcast in this clone bot needs the Main Owner's permission. Tap the button to send a request."), {
      reply_markup: markup([[btn('📨 Request permission', 'cl:bq', { style: 'primary' })]]),
    });
  }
  if (!(await canBroadcast(ctx, msg.from.id))) return reply(ctx, msg, messages.warning('Not Allowed', 'Only the owner and captains can broadcast.'));

  const counts = await countRecipients(ctx.db, target);
  if (counts.total === 0) return reply(ctx, msg, messages.warning('No Recipients', 'There are no registered recipients for this target yet.'));
  if (!ctx.config.bindings.queue) {
    return reply(ctx, msg, messages.error('Queue Not Configured', 'Broadcasts need the BROADCAST_QUEUE binding. See the README (Queues) and redeploy.'));
  }

  // Show exactly what will be sent. If Telegram rejects it here, it would fail for everyone.
  try {
    await sendPayload(ctx, msg.chat.id, built.payload, { autoRetry: true });
  } catch (e) {
    return reply(ctx, msg, messages.error('Preview Failed', `Telegram rejected this message: ${e.message}`));
  }

  const id = await createPending(ctx.db, { kind: 'broadcast', userId: msg.from.id, chatId: msg.chat.id, payload: { target, payload: built.payload }, ttlSec: 900 });
  const approved = ctx.clone ? [] : await approvedCloneList(ctx.db);
  const cloneOk = CLONE_PAYLOAD_KINDS.has(built.payload.kind);
  const scope = ctx.clone ? 'Here' : 'Main only';
  const text = [
    '📢 <b>Broadcast Preview</b>', '',
    field('🎯', 'Target', TARGET_LABEL[target]),
    field('👥', 'Recipients', `${formatNumber(counts.total)}${target === 'all' ? ` (${formatNumber(counts.users)} users, ${formatNumber(counts.groups)} group${counts.groups === 1 ? "" : "s"})` : ''}`),
    built.buttonCount ? field('🔘', 'Buttons', built.buttonCount) : null,
    !ctx.clone && approved.length ? field('🧬', 'Clone bots', cloneOk ? `${approved.length} approved` : 'skipped (clone bots send text messages only)') : null,
    '', '☝️ This is exactly what recipients will receive.',
    '❓ <b>Choose:</b> pin it or not, and whether to send to clone bots.',
    '⏳ Confirm within 15 minutes.',
  ].filter((l) => l !== null).join('\n');
  const rows = [[
    btn(`📌 Pin · ${scope}`, `bc:go:${id}:pin:m`, { style: 'primary' }),
    btn(`⏭ No pin · ${scope}`, `bc:go:${id}:skip:m`, { style: 'success' }),
  ]];
  if (!ctx.clone && approved.length && cloneOk) {
    rows.push([
      btn('📌 Pin · choose clones', `bc:pick:${id}:pin`, { style: 'primary' }),
      btn('⏭ No pin · choose clones', `bc:pick:${id}:skip`, { style: 'success' }),
    ]);
  }
  rows.push([btn('❌ Cancel', `bc:no:${id}`, { style: 'danger' })]);
  return reply(ctx, msg, text, { reply_markup: markup(rows) });
}

export async function broadcastStatusCommand(ctx, msg, args) {
  const wanted = Number.parseInt(args, 10);
  let job = Number.isInteger(wanted) ? await getJob(ctx.db, wanted) : null;
  if (!job) {
    const [latest] = await recentJobs(ctx.db, 1);
    job = latest ? await getJob(ctx.db, latest.id) : null;
  }
  if (!job) return reply(ctx, msg, messages.notFound('No broadcasts have been created yet.'));
  return reply(ctx, msg, renderProgress(job, await jobStats(ctx.db, job.id)), { reply_markup: progressKeyboard(job) });
}

/** Callbacks: bc:go:<pendingId> | bc:no:<pendingId> | bc:x:<jobId> | bc:r:<jobId> */
export async function broadcastCallback(ctx, cq, parts) {
  if (!(await canBroadcast(ctx, cq.from?.id)) || cq.message?.chat?.type !== 'private') {
    return ctx.tg.answerCallbackQuery(cq.id, '🔒 Only the owner and captains can do this.', true);
  }
  const action = parts[1];
  const arg = parts[2];
  const { chat, message_id: messageId } = cq.message;

  if (action === 'no') {
    await takePending(ctx.db, arg, 'broadcast');
    await ctx.tg.answerCallbackQuery(cq.id, 'Broadcast cancelled.');
    return safeEdit(ctx, chat.id, messageId, messages.warning('Broadcast Cancelled', 'Nothing was sent.'));
  }

  if (action === 'pick' || action === 'tg') {
    const pending = await getPending(ctx.db, arg, 'broadcast');
    if (!pending || Number(pending.user_id) !== Number(cq.from.id)) {
      await ctx.tg.answerCallbackQuery(cq.id, 'This confirmation expired.', true);
      return safeEdit(ctx, chat.id, messageId, messages.warning('Expired', 'Please create the broadcast again.'));
    }
    const data = { ...pending.payload, clones: pending.payload.clones || [], pin: pending.payload.pin ?? null };
    if (action === 'pick') data.pin = parts[3] === 'pin';
    if (action === 'tg') {
      const cloneId = Number(parts[3]);
      data.clones = data.clones.includes(cloneId) ? data.clones.filter((x) => x !== cloneId) : [...data.clones, cloneId];
    }
    await updatePendingPayload(ctx.db, arg, data);
    await ctx.tg.answerCallbackQuery(cq.id, action === 'tg' ? 'Updated.' : '', false);
    return safeEdit(ctx, chat.id, messageId, await cloneSelectionText(ctx, arg, data), { reply_markup: await cloneSelectionKeyboard(ctx, arg, data) });
  }

  if (action === 'go') {
    const pending = await takePending(ctx.db, arg, 'broadcast'); // can only be confirmed once
    if (!pending || Number(pending.user_id) !== Number(cq.from.id)) {
      await ctx.tg.answerCallbackQuery(cq.id, 'This confirmation expired or was already used.', true);
      return safeEdit(ctx, chat.id, messageId, messages.warning('Expired', 'Please create the broadcast again.'));
    }
    await ctx.tg.answerCallbackQuery(cq.id, 'Starting broadcast…');
    const { target, payload } = pending.payload;
    const pin = parts[3] === 'pin';
    const withClones = parts[4] === 'c' && !ctx.clone && CLONE_PAYLOAD_KINDS.has(payload.kind);
    const chosenClones = pending.payload.clones || [];
    if (withClones && !chosenClones.length) {
      return ctx.tg.answerCallbackQuery(cq.id, 'Choose at least one clone bot first, then send again.', true);
    }
    const job = await createJob(ctx.db, { createdBy: cq.from.id, targetType: target, payload: { ...payload, pin }, progressChatId: chat.id });
    await markProgressMessage(ctx.db, job.id, chat.id, messageId);
    try {
      if (job.status === 'queued') await enqueueJob(ctx.env, job.id);
    } catch (e) {
      await setJobStatus(ctx.db, job.id, 'failed', { error: `Could not enqueue: ${e.message}` });
      return safeEdit(ctx, chat.id, messageId, messages.error('Could Not Start', 'The broadcast could not be queued. Check the Queue binding and try again.'));
    }
    if (withClones) {
      const made = await createCloneJobs(ctx, { createdBy: cq.from.id, targetType: target, payload: { ...payload, pin }, cloneIds: chosenClones });
      await ctx.tg.sendMessage(chat.id, made
        ? `🧬 Clone broadcasts queued for ${made} approved clone bot(s). Each sends with its own bot.`
        : '🧬 No approved running clone bots, so only the main bot was used.').catch(() => {});
    }
    const fresh = await getJob(ctx.db, job.id);
    return safeEdit(ctx, chat.id, messageId, renderProgress(fresh, await jobStats(ctx.db, job.id)), { reply_markup: progressKeyboard(fresh) });
  }

  const job = await getJob(ctx.db, Number(arg));
  if (!job) return ctx.tg.answerCallbackQuery(cq.id, 'Job not found.', true);

  if (action === 'x') {
    if (!['queued', 'running'].includes(job.status)) return ctx.tg.answerCallbackQuery(cq.id, 'This broadcast is already finished.', true);
    await setJobStatus(ctx.db, job.id, 'cancelled');
    await ctx.tg.answerCallbackQuery(cq.id, 'Broadcast cancelled. Already-sent messages stay delivered.', true);
  } else {
    await ctx.tg.answerCallbackQuery(cq.id, 'Refreshed.');
  }
  const fresh = await getJob(ctx.db, job.id);
  try {
    await ctx.tg.editMessageText(chat.id, messageId, renderProgress(fresh, await jobStats(ctx.db, job.id)), { reply_markup: progressKeyboard(fresh) });
  } catch (e) {
    if (!isMessageNotModified(e)) throw e;
  }
  return undefined;
}

/** /announce [pin] <text | reply> — group administrators post an announcement through the bot. */
export async function announceCommand(ctx, msg, args, cmd) {
  let contentStart = cmd.argsStart;
  let pin = false;
  const { word, rest } = shiftWord(args);
  if (word.toLowerCase() === 'pin') { pin = true; contentStart = cmd.argsStart + (args.length - rest.length); }

  const built = await buildPayload(ctx, msg, contentStart);
  if (!built.ok) {
    return reply(ctx, msg, built.error === 'empty'
      ? messages.usage(['/announce [pin] <text>', '/announce [pin] (reply to a message)'], ['/announce pin Rules updated — please read the pinned message'], `Add button rows under the text:\n${BUTTON_FORMAT_HELP}`)
      : built.error);
  }
  const sent = await sendPayload(ctx, msg.chat.id, built.payload, { autoRetry: true, extra: msg.message_thread_id && msg.is_topic_message ? { message_thread_id: msg.message_thread_id } : {} });
  if (pin && sent?.message_id) await ctx.tg.pinChatMessage(msg.chat.id, sent.message_id).catch(() => reply(ctx, msg, messages.warning('Could Not Pin', 'Give the bot the “Pin messages” admin right to pin announcements.')));
  await ctx.tg.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
  return undefined;
}

export { getPending, esc };

/** Text of the clone chooser (shown after "choose clones"). */
async function cloneSelectionText(ctx, pendingId, data) {
  const approved = await approvedCloneList(ctx.db);
  return `🧬 <b>Choose clone bots</b>\n\nTap a clone to select it. Only approved, running clone bots are listed.\n\nSelected: ${data.clones.filter((id) => approved.some((c) => Number(c.id) === Number(id))).length}`;
}

async function cloneSelectionKeyboard(ctx, pendingId, data) {
  const approved = await approvedCloneList(ctx.db);
  const pin = data.pin ? 'pin' : 'skip';
  const rows = approved.map((c) => {
    const on = data.clones.includes(Number(c.id));
    return [btn(`${on ? '✅' : '⬜'} ${c.bot_name.slice(0, 24)}`, `bc:tg:${pendingId}:${c.id}`, { style: on ? 'success' : 'primary' })];
  });
  const selected = data.clones.filter((id) => approved.some((c) => Number(c.id) === Number(id))).length;
  rows.push([btn(`📤 Send to ${selected} selected`, `bc:go:${pendingId}:${pin}:c`, { style: 'success' })]);
  rows.push([btn('❌ Cancel', `bc:no:${pendingId}`, { style: 'danger' })]);
  return markup(rows);
}
