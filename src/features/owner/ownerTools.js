// Owner-only tools: /setlogchannel (activity log) and /buttonstyle (button font toggle).

import { getBotSetting, setBotSetting } from '../../database/settings.js';
import { logAudit } from '../../database/roles.js';
import { LOG_CHANNEL_KEY, queueLog, setLogChannel, who } from '../../core/activityLog.js';
import { canUsePerm } from '../../core/captains.js';
import { btn, closeBtn, markup } from '../../keyboards/inlineKeyboard.js';
import { box, row } from '../../ui/design.js';
import { BUTTON_MODES, setButtonMode, currentButtonMode } from '../../ui/typography.js';
import { esc, messages } from '../../utils/formatter.js';
import { reply, safeEdit } from '../../handlers/helpers.js';
import { logger } from '../../utils/logger.js';

const CHAT_ID_RE = /^-?\d{5,16}$/;

/** /setlogchannel <chat id> | off — the owner's activity feed. The bot posts a test line before saving. */
export async function setlogchannelCommand(ctx, msg, args = '') {
  const raw = String(args || '').trim();
  const current = await getBotSetting(ctx.db, LOG_CHANNEL_KEY, '');
  if (!raw) {
    return reply(ctx, msg, `${box('📜', 'Activity Log')}\n\n${row('📌', 'Channel', current ? `<code>${esc(current)}</code>` : 'not set', { raw: true })}\n\n<blockquote>Use <code>/setlogchannel -100XXXXXXXXXX</code> to send every activity there, or <code>/setlogchannel off</code> to stop.</blockquote>`, { reply_markup: markup([[closeBtn()]]) });
  }
  if (raw.toLowerCase() === 'off') {
    await setLogChannel(ctx, null);
    await logAudit(ctx.db, { actor: msg.from.id, action: 'logchannel_off' });
    return reply(ctx, msg, messages.success('Activity Log Stopped', 'Nothing more will be sent to the log channel.'));
  }
  if (!CHAT_ID_RE.test(raw)) {
    return reply(ctx, msg, messages.usage(['/setlogchannel <channel id>', '/setlogchannel off'], ['/setlogchannel -1001234567890'], 'Add the bot to the channel as an administrator with "Post messages" first.'));
  }
  const chatId = Number(raw);
  try {
    await ctx.tg.sendMessage(chatId, `${box('✅', 'Activity Log Connected')}\n\n<blockquote>Every command, button tap, moderation action, global ban and error will be posted here.</blockquote>`);
  } catch (e) {
    logger.warn('log channel test failed', { error: e?.message });
    return reply(ctx, msg, messages.error('Could Not Post There', `I could not post to ${raw}. Add me to that channel as an administrator with the "Post messages" right, then try again. (${String(e?.message || '').slice(0, 120)})`));
  }
  await setLogChannel(ctx, chatId);
  await logAudit(ctx.db, { actor: msg.from.id, action: 'logchannel_set', detail: raw });
  return reply(ctx, msg, messages.success('Activity Log Set', `Logging to ${raw} is on. A test message was posted there.`));
}

// ---------------------------------------------------------------- /buttonstyle

function styleScreen(current) {
  const names = { block: 'Block capitals + bold', italic: 'Bold italic, first letter capital' };
  const sample = current === 'italic' ? '𝙃𝙚𝙡𝙡𝙤 𝘾𝙤𝙢𝙢𝙖𝙣𝙙𝙨' : '𝗛𝗘𝗟𝗟𝗢 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦';
  return {
    text: `${box('🔤', 'Button Style')}\n\n<blockquote>Choose how button labels look. Your choice applies to every button the bot shows.</blockquote>\n\n${row('🎨', 'Current', names[current] || current, { raw: false })}\n${row('👀', 'Preview', sample, { raw: true })}`,
    keyboard: markup([
      [btn(`${current === 'block' ? '✅ ' : ''}BLOCK + BOLD`, 'bs:set:block', { style: 'primary' }), btn(`${current === 'italic' ? '✅ ' : ''}ITALIC + BOLD`, 'bs:set:italic', { style: 'primary' })],
      [closeBtn()],
    ]),
  };
}

export async function buttonstyleCommand(ctx, msg, args = '') {
  const want = String(args || '').trim().toLowerCase();
  if (want && BUTTON_MODES.includes(want)) return applyStyle(ctx, msg.from.id, want, (t, k) => reply(ctx, msg, t, { reply_markup: k }));
  const s = styleScreen(currentButtonMode());
  return reply(ctx, msg, s.text, { reply_markup: s.keyboard });
}

async function applyStyle(ctx, userId, mode, send) {
  await setBotSetting(ctx.db, 'button_style', mode);
  setButtonMode(mode);
  await logAudit(ctx.db, { actor: userId, action: 'buttonstyle', detail: mode });
  queueLog(ctx, `🔤 Button style set to <b>${esc(mode)}</b> by ${who({ id: userId })}`);
  const s = styleScreen(mode);
  return send(s.text, s.keyboard);
}

/** bs:set:<block|italic> — owner only; the tapper is re-checked on every tap. */
export async function buttonStyleCallback(ctx, cq, parts) {
  if (!(await canUsePerm(ctx, cq.from.id, 'buttons'))) return ctx.tg.answerCallbackQuery(cq.id, '🔒 Only the bot owner, or a captain allowed for this, can change this.', true);
  const mode = parts[2];
  if (!BUTTON_MODES.includes(mode)) return ctx.tg.answerCallbackQuery(cq.id, 'Unknown style.');
  await ctx.tg.answerCallbackQuery(cq.id, mode === 'italic' ? 'Italic + bold selected' : 'Block + bold selected');
  const m = cq.message;
  return applyStyle(ctx, cq.from.id, mode, (t, k) => safeEdit(ctx, m.chat.id, m.message_id, t, { reply_markup: k }));
}
