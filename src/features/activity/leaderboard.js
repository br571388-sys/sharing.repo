// /leaderboard: the Top 10 members of this group by message count, as a picture from the image service.
// Buttons switch between Today, Weekly and Monthly and update the same picture.
import { btn, markup } from '../../keyboards/inlineKeyboard.js';
import { messages } from '../../utils/formatter.js';
import { reply } from '../../handlers/helpers.js';
import { box } from '../../ui/design.js';
import { recordError } from '../../core/errorHandler.js';
import { fetchAvatar, ImageApiError, imageApiReady, renderImage } from '../../services/imageApi.js';
import { globalLeaderboardRows, leaderboardRows, periodRange } from './activity.js';

const TITLES = { d: 'Today', w: 'Weekly', m: 'Monthly' };

const SCOPES = { g: 'Group', a: 'Global' };

/** Period buttons, plus the Group / Global switch for the other scope. */
const buttons = (chatId, period, scope) => markup([
  [
    btn('Today', `lb:d:${chatId}:${scope}`, { style: period === 'd' ? 'success' : 'primary' }),
    btn('Weekly', `lb:w:${chatId}:${scope}`, { style: period === 'w' ? 'success' : 'primary' }),
    btn('Monthly', `lb:m:${chatId}:${scope}`, { style: period === 'm' ? 'success' : 'primary' }),
  ],
  [scope === 'g'
    ? btn('🌍 Global', `lb:${period}:${chatId}:a`, { style: 'primary' })
    : btn('👥 Group', `lb:${period}:${chatId}:g`, { style: 'primary' })],
]);

/** Builds the picture for one period. Returns { bytes, rows } or { empty: true }. Throws ImageApiError on failure. */
async function buildBoard(ctx, chatId, period, scope = 'g') {
  const rows = scope === 'a' ? await globalLeaderboardRows(ctx.db, period, 10) : await leaderboardRows(ctx.db, chatId, period, 10);
  if (!rows.length) return { empty: true };
  const entries = await Promise.all(rows.map(async (r) => ({
    name: r.first_name || 'Member',
    username: r.username || '',
    score: Number(r.score),
    avatar: await fetchAvatar(ctx, r.user_id),
  })));
  const { from, to } = periodRange(period);
  const image = await renderImage(ctx, '/leaderboard', { title: 'Leaderboard', period: `${TITLES[period]} · ${SCOPES[scope]}`, from, to, rows: entries });
  return { ...image, rows };
}

const caption = (period, scope = 'g') => box('🏆', `Leaderboard · ${TITLES[period]} · ${SCOPES[scope]}`);

export async function leaderboardCommand(ctx, msg) {
  if (!imageApiReady(ctx.config)) return reply(ctx, msg, messages.warning('Not Set Up', 'The leaderboard picture service is not set up yet. The owner must set IMAGE_API_URL.'));
  try {
    const board = await buildBoard(ctx, msg.chat.id, 'd', 'g');
    if (board.empty) return reply(ctx, msg, messages.warning('No Messages Yet', 'No messages have been counted in this group today.'));
    return ctx.tg.sendPhotoBytes(msg.chat.id, board.bytes, caption('d', 'g'), { reply_markup: buttons(msg.chat.id, 'd', 'g'), reply_parameters: { message_id: msg.message_id } });
  } catch (e) {
    await recordError(ctx, 'leaderboard', e);
    return reply(ctx, msg, messages.warning('Leaderboard Failed', e instanceof ImageApiError ? e.message : 'The leaderboard could not be made. Please try again.'));
  }
}

/** lb:<d|w|m>:<chatId>:<g|a> — switches the period or the scope (Group / Global) of the same picture. */
export async function leaderboardCallback(ctx, cq, parts) {
  const period = parts[1];
  const chatId = Number(parts[2]);
  const scope = parts[3] === 'a' ? 'a' : 'g';
  if (!TITLES[period] || !Number.isInteger(chatId)) return ctx.tg.answerCallbackQuery(cq.id, 'This button is no longer valid.', true);
  if (!imageApiReady(ctx.config)) return ctx.tg.answerCallbackQuery(cq.id, 'The picture service is not set up yet.', true);
  try {
    const board = await buildBoard(ctx, chatId, period, scope);
    if (board.empty) return ctx.tg.answerCallbackQuery(cq.id, `No messages counted ${TITLES[period].toLowerCase()} yet.`, true);
    await ctx.tg.editPhotoBytes(chatId, cq.message.message_id, board.bytes, caption(period, scope), { reply_markup: buttons(chatId, period, scope) });
    return ctx.tg.answerCallbackQuery(cq.id, `Showing ${TITLES[period]} · ${SCOPES[scope]}.`, false);
  } catch (e) {
    await recordError(ctx, 'leaderboard callback', e);
    return ctx.tg.answerCallbackQuery(cq.id, e instanceof ImageApiError ? e.message.slice(0, 180) : 'Could not update the leaderboard. Try again.', true);
  }
}
