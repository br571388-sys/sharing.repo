import { queueLog } from './activityLog.js';
import { esc } from '../ui/escape.js';
// Central error handling: log full details (redacted), show users a safe generic message.

import { logger } from '../utils/logger.js';
import { messages } from '../utils/formatter.js';
import { ApiError, DbError, PermissionError, TelegramError, ValidationError } from '../utils/errors.js';
import { setBotSetting } from '../database/settings.js';

/** Safe, user-facing HTML for an error. Never contains stack traces, SQL or tokens. */
export function userErrorMessage(err) {
  if (err instanceof PermissionError) return messages.denied(err.userMessage || undefined);
  if (err instanceof ValidationError) return messages.warning('Invalid Input', err.userMessage || err.message);
  if (err instanceof ApiError) return messages.unavailable(err.userMessage || undefined);
  if (err instanceof DbError) return messages.error('Database Unavailable', 'The bot could not reach its database right now. Please try again in a moment.');
  if (err instanceof TelegramError) return messages.error('Telegram Error', 'Telegram did not accept the request. Please try again.');
  return messages.error('Something Went Wrong', 'An unexpected error occurred. The issue has been logged — please try again.');
}

export async function recordError(ctx, where, err) {
  logger.error(`${where}: ${err?.message || err}`, { stack: String(err?.stack || '').split('\n').slice(0, 4).join(' | ') });
  queueLog(ctx, `⚠️ <b>error</b> in ${esc(where)}: ${esc(String(err?.message || err).slice(0, 160))}`);
  try {
    await setBotSetting(ctx.db, 'last_error', `${where}: ${String(err?.message || err).slice(0, 200)}`);
    await setBotSetting(ctx.db, 'last_error_at', Math.floor(Date.now() / 1000));
  } catch { /* database may be the thing that failed */ }
}

/** Wraps a handler so errors become a friendly reply instead of a silent failure. */
export async function safely(ctx, where, chatId, fn) {
  try {
    return await fn();
  } catch (err) {
    await recordError(ctx, where, err);
    if (chatId) {
      try { await ctx.tg.sendMessage(chatId, userErrorMessage(err)); } catch { /* nothing more we can do */ }
    }
    return undefined;
  }
}
