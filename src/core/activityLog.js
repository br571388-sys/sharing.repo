// Activity log: when the owner sets a log channel, every command, button tap, moderation action, global ban,
// sudo change, bot join/leave and error is posted there. Lines are queued during a request and sent once at the end,
// so logging never slows a reply and a failing log channel never breaks a command.

import { getBotSetting, setBotSetting } from '../database/settings.js';
import { logModeration } from '../database/groupMod.js';
import { esc } from '../ui/escape.js';
import { logger } from '../utils/logger.js';

export const LOG_CHANNEL_KEY = 'log_channel';
const MAX = 3800;

/** Queues one HTML line for the log channel (sent by flushActivityLog). */
export function queueLog(ctx, html) {
  if (!ctx) return;
  (ctx._logQueue ||= []).push(`<code>${new Date().toISOString().slice(11, 19)}</code> ${html}`);
}

export const who = (user) => (user ? `${user.username ? `@${esc(user.username)}` : esc(user.first_name || 'user')} <code>${user.id}</code>` : 'system');

/** Sends every queued line to the log channel, grouped into as few messages as possible. Never throws. */
export async function flushActivityLog(ctx) {
  const lines = ctx?._logQueue;
  if (!lines?.length) return 0;
  ctx._logQueue = [];
  let channel = null;
  try { channel = await getBotSetting(ctx.db, LOG_CHANNEL_KEY, ''); } catch { return 0; }
  if (!channel) return 0;
  let chunk = '';
  const send = async (text) => {
    try { await ctx.tg.sendMessage(Number(channel), text); } catch (e) { logger.warn('log channel send failed', { error: e?.message }); }
  };
  for (const line of lines) {
    if (chunk && chunk.length + line.length + 1 > MAX) { await send(chunk); chunk = ''; }
    chunk += (chunk ? '\n' : '') + line;
  }
  if (chunk) await send(chunk);
  return lines.length;
}

/** Drop-in replacement for logModerationLogged(ctx, …) that also reports the action to the log channel. */
export async function logModerationLogged(ctx, group, entry) {
  await logModeration(ctx.db, group, entry);
  if (ctx?._inCommand) return; // the command itself is already logged
  const where = esc(group?.title || `group ${group?.telegram_chat_id ?? group?.id ?? ''}`);
  queueLog(ctx, `🔨 <b>${esc(entry.action)}</b> · ${where}${entry.target ? ` · target <code>${entry.target}</code>` : ''}${entry.moderator ? ` · by <code>${entry.moderator}</code>` : ''}${entry.reason ? ` · ${esc(String(entry.reason).slice(0, 120))}` : ''}`);
}

export async function setLogChannel(ctx, chatId) {
  await setBotSetting(ctx.db, LOG_CHANNEL_KEY, chatId === null ? '' : String(chatId));
}
