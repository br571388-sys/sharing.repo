// /button — build a message with inline buttons from the custom text format, and the handler for the
// pop-up (callback) buttons it creates.

import { buildPayload, sendPayload } from '../broadcast/sender.js';
import { BUTTON_FORMAT_HELP } from '../../keyboards/buttonParser.js';
import { getButtonCallback } from '../../database/state.js';
import { esc, messages } from '../../utils/formatter.js';
import { reply, reactOk } from '../../handlers/helpers.js';
import { boxHtml } from '../../ui/design.js';

const USAGE = () => messages.usage(
  ['/button <message text>\n<button rows>', '/button <button rows> (reply to a message)'],
  [
    '/button Pick a quality\n(480p - https://example.com/480) | (720p - https://example.com/720)\n(Info - Files are 100% safe)',
  ],
  `Button format:\n${BUTTON_FORMAT_HELP}`,
);

export async function buttonCommand(ctx, msg, args, cmd) {
  const built = await buildPayload(ctx, msg, cmd.argsStart);
  if (!built.ok) return reply(ctx, msg, built.error === 'empty' ? USAGE() : built.error);
  if (!built.buttonCount) {
    return reply(ctx, msg, `${boxHtml("⚠️", "No Buttons Found")}\n\nAdd button rows under your message:\n<code>${esc(BUTTON_FORMAT_HELP)}</code>`);
  }
  await sendPayload(ctx, msg.chat.id, built.payload, {
    autoRetry: true,
    extra: msg.message_thread_id && msg.is_topic_message ? { message_thread_id: msg.message_thread_id } : {},
  });
  if (msg.chat.type !== 'private') await ctx.tg.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
  else await reactOk(ctx, msg, '👍');
  return undefined;
}

/**
 * Callback "cb:<id>" — shows the stored text as a pop-up. This is the ONLY thing a custom button can do:
 * the id is looked up in our table, so nothing arbitrary is ever executed.
 */
export async function customButtonCallback(ctx, cq) {
  const id = String(cq.data || '');
  if (!/^cb:[a-f0-9]{20}$/.test(id)) return ctx.tg.answerCallbackQuery(cq.id, 'Invalid button.');
  const text = await getButtonCallback(ctx.db, id);
  if (!text) return ctx.tg.answerCallbackQuery(cq.id, 'This button is no longer available.', true);
  return ctx.tg.answerCallbackQuery(cq.id, text, ctx.config.buttonPopupAlert);
}
