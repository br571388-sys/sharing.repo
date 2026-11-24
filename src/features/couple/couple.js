// /couple: once per group per 24 hours, 10 random couples are picked from active members (20 people).
// /mypartner: shows a member's partner from the current selection, or a random trolling line when there is none.
import { getBotSetting } from '../../database/settings.js';
import { esc, messages } from '../../utils/formatter.js';
import { reply } from '../../handlers/helpers.js';
import { box } from '../../ui/design.js';
import { recordError } from '../../core/errorHandler.js';
import { nowSec, sleep } from '../../utils/helpers.js';
import { fetchAvatar, ImageApiError, imageApiReady, renderImage } from '../../services/imageApi.js';
import { dayKey } from '../activity/activity.js';

export const COUPLE_WINDOW_SEC = 24 * 60 * 60;
export const COUPLE_PEOPLE = 20;
const ACTIVE_DAYS = 7;
const MAX_VERIFY = 40; // getChatMember checks per selection (keeps the request within Worker limits)

/** Default trolling lines for /mypartner (the owner can change the list later). */
export const DEFAULT_TROLLS = [
  'SINGLE HEE MAREGA BHAI TU 😂',
  'HAI TERI GIRLFRIEND HAI 🫵🏻😂',
  'Partner dhoondh raha hai? Pehle group ke bahar dhoondh, yahan toh sab ka scene set hai 😂',
  'Bhai tera partner abhi tak Wi-Fi password mein hi atka hai 📶😂',
  'Dil toot gaya? Nahi bhai, bas koi aaya hi nahi 💔😂',
  'Tera naam aaj bhi single list mein top par hai 🏆😂',
  'Kisi ne tujhe like nahi kiya, par tu sabko reply karta hai 😅',
  'Partner ka wait kar, tab tak chai pe baat karte hain ☕😂',
  'Tere ghar wale bhi pooch rahe honge: "Beta, kab shaadi?" 😂',
  'Single ho bhai? Koi nahi, Monday ka pyaar bhi aata hai 📅😂',
  'Reel dekhte dekhte saal nikal gaya, par partner nahi mila 🎬😂',
  'Tu kisi ko propose karega ya bas sochta rahega? 🤔😂',
  'Group mein sab couple bante hain, tu bas "seen" karta hai 👀😂',
  'Teri love story abhi draft mein hai bhai 📝😂',
  'Bhai, WhatsApp status khaali hai, dil bhi khaali hai? 📱😂',
  'Abhi tak koi nahi mila? Ek kaam kar, mirror se baat kar 🪞😂',
  'Tera partner shayad dusri city mein hai, bas location off hai 📍😂',
  'Dating app pe bhi swipe left hi chal raha hai kya? 👈😂',
  'Dil mein sab kuch hai, bas ek bhi nahi hai 😂',
  'Koi nahi milega toh bhi chalega, chai toh hai na ☕😂',
];

const isOpenSelection = (row, now) => row && row.created_at + COUPLE_WINDOW_SEC > now;

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const nameOf = (p) => p.first_name || p.username || 'Member';

/** Active candidates: spoke in the last 7 days, still in the group, not bots and not deleted accounts. */
async function activeCandidates(ctx, chatId, now) {
  const rows = await ctx.db.all(
    `SELECT m.user_id AS user_id, m.first_name AS first_name, m.username AS username
     FROM group_members m
     JOIN (SELECT user_id, SUM(count) AS c FROM group_daily_counts WHERE chat_id = ? AND day >= ? GROUP BY user_id) a ON a.user_id = m.user_id
     WHERE m.chat_id = ? AND m.left_at IS NULL AND m.is_bot = 0`,
    [Number(chatId), dayKey(now - ACTIVE_DAYS * 86400), Number(chatId)],
  );
  const botId = (await ctx.botInfo()).id;
  return rows.filter((r) => r.user_id !== botId && r.first_name !== 'Deleted Account');
}

/** Picks couples. Returns [{ a, b }] (at most 10 pairs, never the same person twice). */
export async function selectCouples(ctx, chatId, now = nowSec()) {
  const candidates = shuffle(await activeCandidates(ctx, chatId, now));
  const verified = [];
  for (let i = 0; i < candidates.length && i < MAX_VERIFY && verified.length < COUPLE_PEOPLE; i++) {
    const c = candidates[i];
    try {
      const m = await ctx.tg.call('getChatMember', { chat_id: Number(chatId), user_id: c.user_id });
      if (['member', 'administrator', 'creator', 'restricted'].includes(m?.status) && m?.is_member !== false && !m?.user?.is_bot) verified.push(c);
    } catch { /* not verifiable: skip this person */ }
  }
  const people = verified.slice(0, COUPLE_PEOPLE);
  const pairs = [];
  for (let i = 0; i + 1 < people.length; i += 2) pairs.push({ a: people[i], b: people[i + 1] });
  return pairs;
}

/** /couple: selects today's couples and sends one picture per couple. */
export async function coupleCommand(ctx, msg) {
  const chatId = msg.chat.id;
  const row = await ctx.db.first('SELECT created_at, pairs FROM group_couples WHERE chat_id = ?', [Number(chatId)]);
  if (isOpenSelection(row, nowSec())) return reply(ctx, msg, "Today's couples have already been selected!");
  if (!imageApiReady(ctx.config)) return reply(ctx, msg, messages.warning('Not Set Up', 'The couple picture service is not set up yet. The owner must set IMAGE_API_URL.'));
  try {
    const pairs = await selectCouples(ctx, chatId);
    if (pairs.length === 0) return reply(ctx, msg, messages.warning('Not Enough Members', 'At least two active members (who spoke in the last 7 days) are needed.'));
    const now = nowSec();
    await ctx.db.execute(
      `INSERT INTO group_couples (chat_id, created_at, pairs) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET created_at = excluded.created_at, pairs = excluded.pairs`,
      [Number(chatId), now, JSON.stringify(pairs.map((p) => [p.a.user_id, p.b.user_id, nameOf(p.a), nameOf(p.b)]))],
    );
    let sent = 0;
    const failed = [];
    for (const p of pairs) {
      try {
        const [avatarA, avatarB] = [await fetchAvatar(ctx, p.a.user_id), await fetchAvatar(ctx, p.b.user_id)];
        const image = await renderImage(ctx, '/couple', { names: [nameOf(p.a), nameOf(p.b)], avatars: [avatarA, avatarB] });
        await ctx.tg.sendPhotoBytes(chatId, image.bytes, `💞 <b>${esc(nameOf(p.a))}</b> & <b>${esc(nameOf(p.b))}</b>`);
        sent++;
        await sleep(400);
      } catch (e) {
        failed.push(e instanceof ImageApiError ? e.message : 'picture failed');
      }
    }
    if (sent === 0) return reply(ctx, msg, messages.warning('Pictures Failed', `The couples were selected, but no picture could be made. ${esc(failed[0] || '')}`));
    const note = failed.length ? ` (${failed.length} picture(s) could not be made)` : '';
    return reply(ctx, msg, box('💞', `${pairs.length} Couples Selected${note}`));
  } catch (e) {
    await recordError(ctx, 'couple', e);
    return reply(ctx, msg, messages.warning('Couples Failed', 'The couples could not be selected. Please try again.'));
  }
}

/** /mypartner: the member's partner from today's selection, or a random trolling line. */
export async function mypartnerCommand(ctx, msg) {
  const row = await ctx.db.first('SELECT created_at, pairs FROM group_couples WHERE chat_id = ?', [Number(msg.chat.id)]);
  const uid = Number(msg.from.id);
  if (isOpenSelection(row, nowSec())) {
    const pairs = JSON.parse(row.pairs);
    const pair = pairs.find((p) => p[0] === uid || p[1] === uid);
    if (pair) {
      const partner = pair[0] === uid ? [pair[1], pair[3]] : [pair[0], pair[2]];
      return reply(ctx, msg, box('💞', `Your partner today: ${esc(partner[1])}`));
    }
  }
  const custom = await getBotSetting(ctx.db, 'couple_trolls', '');
  let list = DEFAULT_TROLLS;
  try { if (custom) { const parsed = JSON.parse(custom); if (Array.isArray(parsed) && parsed.length) list = parsed; } } catch { /* keep the defaults */ }
  return reply(ctx, msg, list[Math.floor(Math.random() * list.length)]);
}
