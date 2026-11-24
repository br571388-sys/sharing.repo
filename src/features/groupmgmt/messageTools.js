// Message management: /del /purge /spurge /purgefrom /purgeto /pin /unpin /pinmessage /unpinmessage.
import { logModerationLogged } from '../../core/activityLog.js';
//
// Purges delete messages ONE BY ONE (bounded concurrency) so the reported count is exactly what Telegram confirmed.
// Telegram only lets a bot delete messages younger than 48 hours (in groups); older ones are counted as "skipped".

import { getGroup } from '../../database/groups.js';
import { deleteGroupData, getGroupData, setGroupData } from '../../database/settings.js';
import { logModeration } from '../../database/groupMod.js';
import { field, messages } from '../../utils/formatter.js';
import { mapLimit, nowSec } from '../../utils/helpers.js';
import { reply } from '../../handlers/helpers.js';
import { botRightProblem, senderRight, tgFailure, tryDelete } from './util.js';
import { shiftWord } from '../../utils/command.js';
import { scheduleDelete } from '../../database/groupMod.js';
import { boxHtml } from '../../ui/design.js';

export const PURGE_MAX = 500; // messages per purge: keeps one webhook run well inside Cloudflare's limits

async function gate(ctx, msg, userRight, botRight) {
  const sr = await senderRight(ctx, msg, userRight);
  if (!sr.ok) return sr.error;
  return botRightProblem(ctx, msg.chat.id, botRight);
}

/** /del — delete the replied-to message (and the command). */
export async function delCommand(ctx, msg) {
  const problem = await gate(ctx, msg, 'can_delete_messages', 'can_delete_messages');
  if (problem) return reply(ctx, msg, problem);
  const target = msg.reply_to_message;
  if (!target) return reply(ctx, msg, messages.usage(['/del (reply to a message)'], [], 'Reply to the message you want deleted.'));
  const group = await getGroup(ctx.db, msg.chat.id);
  try {
    await ctx.tg.deleteMessage(msg.chat.id, target.message_id);
  } catch (e) {
    return reply(ctx, msg, tgFailure(e, 'delete the message'));
  }
  await logModerationLogged(ctx, group, { action: 'del', target: target.from?.id ?? null, moderator: msg.from.id, messageId: target.message_id });
  await tryDelete(ctx, msg.chat.id, msg.message_id);
  return undefined;
}

/** Deletes message ids from..to (inclusive) one by one. Returns { deleted, failed }. */
export async function deleteRange(ctx, chatId, from, to) {
  const ids = [];
  for (let id = from; id <= to; id++) ids.push(id);
  let deleted = 0;
  let failed = 0;
  let stop = false;
  await mapLimit(ids, 8, async (id) => {
    if (stop) { failed++; return; }
    try {
      await ctx.tg.deleteMessage(chatId, id);
      deleted++;
    } catch (e) {
      failed++;
      if (/not enough rights|chat_admin_required|chat not found/i.test(String(e?.message))) stop = true;
    }
  });
  return { deleted, failed };
}

async function runPurge(ctx, msg, from, to, silent) {
  const group = await getGroup(ctx.db, msg.chat.id);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) return reply(ctx, msg, messages.error('Invalid Range', 'The message range is not valid.'));
  if (to - from + 1 > PURGE_MAX) {
    return reply(ctx, msg, messages.warning('Range Too Large', `A single purge can cover at most ${PURGE_MAX} messages (yours spans ${to - from + 1}). Purge in smaller steps.`));
  }
  const { deleted, failed } = await deleteRange(ctx, msg.chat.id, from, to);
  await logModerationLogged(ctx, group, { action: 'purge', moderator: msg.from.id, reason: `${deleted} deleted, ${failed} skipped (ids ${from}-${to})`, messageId: from, result: deleted ? 'success' : 'failed: nothing deleted' });
  await tryDelete(ctx, msg.chat.id, msg.message_id);
  if (silent) return undefined;
  const text = `${boxHtml("🗑️", "PURGE COMPLETE")}\n\n${field('✅', 'Deleted', deleted)}${failed ? `\n${field('⏭️', 'Skipped', `${failed} (already deleted, older than 48 hours, or not deletable)`)}` : ''}`;
  const note = await ctx.tg.sendMessage(msg.chat.id, text).catch(() => null);
  if (note) await scheduleDelete(ctx.db, msg.chat.id, note.message_id, 30).catch(() => {});
  return undefined;
}

async function purge(ctx, msg, silent) {
  const problem = await gate(ctx, msg, 'can_delete_messages', 'can_delete_messages');
  if (problem) return reply(ctx, msg, problem);
  const start = msg.reply_to_message;
  if (!start) return reply(ctx, msg, messages.usage([`/${silent ? 'spurge' : 'purge'} (reply to the FIRST message to delete)`], [], 'Deletes everything from the replied message up to your command (max 500 messages, newer than 48 hours).'));
  return runPurge(ctx, msg, start.message_id, msg.message_id - 1, silent);
}

export const purgeCommand = (ctx, msg) => purge(ctx, msg, false);
export const spurgeCommand = (ctx, msg) => purge(ctx, msg, true);

/** /purgefrom (reply) marks the start; /purgeto (reply) deletes from the mark to that message. */
export async function purgefromCommand(ctx, msg) {
  const problem = await gate(ctx, msg, 'can_delete_messages', 'can_delete_messages');
  if (problem) return reply(ctx, msg, problem);
  if (!msg.reply_to_message) return reply(ctx, msg, messages.usage(['/purgefrom (reply to the first message)'], [], 'Then reply to the last message with /purgeto.'));
  const group = await getGroup(ctx.db, msg.chat.id);
  await setGroupData(ctx.db, group, 'purgefrom', String(msg.from.id), JSON.stringify({ id: msg.reply_to_message.message_id, at: nowSec() }));
  await tryDelete(ctx, msg.chat.id, msg.message_id);
  const note = await ctx.tg.sendMessage(msg.chat.id, `${boxHtml("📍", "Purge start marked.")}\nNow reply to the LAST message with /purgeto.`).catch(() => null);
  if (note) await scheduleDelete(ctx.db, msg.chat.id, note.message_id, 30).catch(() => {});
  return undefined;
}

export async function purgetoCommand(ctx, msg) {
  const problem = await gate(ctx, msg, 'can_delete_messages', 'can_delete_messages');
  if (problem) return reply(ctx, msg, problem);
  if (!msg.reply_to_message) return reply(ctx, msg, messages.usage(['/purgeto (reply to the last message)'], [], 'Use /purgefrom first to mark the start.'));
  const group = await getGroup(ctx.db, msg.chat.id);
  const raw = await getGroupData(ctx.db, group, 'purgefrom', String(msg.from.id));
  const mark = raw ? JSON.parse(raw) : null;
  if (!mark || nowSec() - mark.at > 3600) return reply(ctx, msg, messages.warning('No Start Marked', 'Mark the first message with /purgefrom (reply to it) — the mark lasts one hour.'));
  await deleteGroupData(ctx.db, group, 'purgefrom', String(msg.from.id));
  const to = msg.reply_to_message.message_id;
  if (to < mark.id) return reply(ctx, msg, messages.warning('Wrong Order', 'The end message must come AFTER the start message.'));
  return runPurge(ctx, msg, mark.id, to, false);
}

// ---------------------------------------------------------------- pinning
export async function pinCommand(ctx, msg, args) {
  const problem = await gate(ctx, msg, 'can_pin_messages', 'can_pin_messages');
  if (problem) return reply(ctx, msg, problem);
  const group = await getGroup(ctx.db, msg.chat.id);
  const { word, rest } = shiftWord(args);
  const loud = word.toLowerCase() === 'loud' || word.toLowerCase() === 'notify';
  const text = loud ? rest : args.trim();

  let target = msg.reply_to_message?.message_id;
  if (!target && text) {
    // /pinmessage <text>: post the text and pin it.
    try {
      const sent = await ctx.tg.sendMessage(msg.chat.id, text.slice(0, 3500));
      target = sent.message_id;
    } catch (e) { return reply(ctx, msg, tgFailure(e, 'send the message')); }
  }
  if (!target) return reply(ctx, msg, messages.usage(['/pin (reply to a message)', '/pin loud (reply) — notify everyone', '/pinmessage <text> — post and pin'], ['/pin loud']));
  try {
    await ctx.tg.pinChatMessage(msg.chat.id, target, !loud);
  } catch (e) {
    await logModerationLogged(ctx, group, { action: 'pin', moderator: msg.from.id, messageId: target, result: `failed: ${String(e?.message).slice(0, 100)}` });
    return reply(ctx, msg, tgFailure(e, 'pin the message'));
  }
  await logModerationLogged(ctx, group, { action: 'pin', moderator: msg.from.id, messageId: target });
  return reply(ctx, msg, `${boxHtml("📌", "MESSAGE PINNED")}\n\n${field('🔔', 'Notification', loud ? 'sent to members' : 'silent')}`);
}

export async function unpinCommand(ctx, msg, args) {
  const problem = await gate(ctx, msg, 'can_pin_messages', 'can_pin_messages');
  if (problem) return reply(ctx, msg, problem);
  const group = await getGroup(ctx.db, msg.chat.id);
  const all = args.trim().toLowerCase() === 'all';
  try {
    if (all) await ctx.tg.unpinAllChatMessages(msg.chat.id);
    else await ctx.tg.unpinChatMessage(msg.chat.id, msg.reply_to_message?.message_id);
  } catch (e) {
    await logModerationLogged(ctx, group, { action: 'unpin', moderator: msg.from.id, result: `failed: ${String(e?.message).slice(0, 100)}` });
    return reply(ctx, msg, tgFailure(e, 'unpin'));
  }
  await logModerationLogged(ctx, group, { action: all ? 'unpinall' : 'unpin', moderator: msg.from.id, messageId: msg.reply_to_message?.message_id ?? null });
  return reply(ctx, msg, `📌 <b>${all ? 'ALL MESSAGES UNPINNED' : 'MESSAGE UNPINNED'}</b>\n\n${all ? '' : msg.reply_to_message ? 'The replied message was unpinned.' : 'The most recent pinned message was unpinned.'}`.trim());
}
