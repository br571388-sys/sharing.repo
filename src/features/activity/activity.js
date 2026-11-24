// Group message activity for the leaderboard.
// Counts are per group, per user, per IST day. Anti-flood: 5 messages within 2 seconds mutes the user's messages for
// the leaderboard for 20 minutes (the messages are not counted; the bot does not restrict anyone).
import { nowSec } from '../../utils/helpers.js';
import { IST_OFFSET_SEC, istDayStart } from '../../services/timezone.js';

export const FLOOD_MESSAGES = 5;
export const FLOOD_WINDOW_SEC = 2;
export const FLOOD_MUTE_SEC = 20 * 60;

/** IST calendar day as YYYY-MM-DD. */
export function dayKey(unixSec) {
  return new Date((unixSec + IST_OFFSET_SEC) * 1000).toISOString().slice(0, 10);
}

/** Date range (YYYY-MM-DD, inclusive) for a leaderboard period, in IST. */
export function periodRange(period, now = nowSec()) {
  const today = dayKey(now);
  if (period === 'd') return { from: today, to: today };
  if (period === 'w') return { from: dayKey(istDayStart(now, -6)), to: today }; // the last 7 days including today
  if (period === 'm') return { from: `${today.slice(0, 8)}01`, to: today }; // the calendar month so far
  throw new Error(`unknown period ${period}`);
}

/**
 * Counts one group message for the leaderboard. Returns true when counted.
 * Flood state is kept in group_flood; counts in group_daily_counts (kept forever, so history survives members leaving).
 */
export async function countGroupMessage(db, msg, now = nowSec()) {
  const chatId = Number(msg.chat.id);
  const userId = Number(msg.from.id);
  const st = await db.first('SELECT window_end, hits, muted_until FROM group_flood WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
  if (st && st.muted_until > now) return false; // flooding: this message does not count

  let hits = 1;
  let windowEnd = now + FLOOD_WINDOW_SEC;
  if (st && st.window_end > now) { hits = st.hits + 1; windowEnd = st.window_end; }
  if (hits >= FLOOD_MESSAGES) {
    await db.execute(
      `INSERT INTO group_flood (chat_id, user_id, window_end, hits, muted_until) VALUES (?, ?, 0, 0, ?)
       ON CONFLICT(chat_id, user_id) DO UPDATE SET window_end = 0, hits = 0, muted_until = excluded.muted_until`,
      [chatId, userId, now + FLOOD_MUTE_SEC],
    );
    return false;
  }
  await db.execute(
    `INSERT INTO group_flood (chat_id, user_id, window_end, hits, muted_until) VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(chat_id, user_id) DO UPDATE SET window_end = excluded.window_end, hits = excluded.hits`,
    [chatId, userId, windowEnd, hits],
  );
  await db.execute(
    `INSERT INTO group_daily_counts (chat_id, user_id, day, count) VALUES (?, ?, ?, 1)
     ON CONFLICT(chat_id, user_id, day) DO UPDATE SET count = count + 1`,
    [chatId, userId, dayKey(now)],
  );
  return true;
}

/** Top members of a group for a period, highest score first. Names come from group_members (kept after leaving). */
export async function leaderboardRows(db, chatId, period, limit = 10, now = nowSec()) {
  const { from, to } = periodRange(period, now);
  return db.all(
    `SELECT c.user_id AS user_id, SUM(c.count) AS score, m.username AS username, m.first_name AS first_name
     FROM group_daily_counts c
     LEFT JOIN group_members m ON m.chat_id = c.chat_id AND m.user_id = c.user_id
     WHERE c.chat_id = ? AND c.day >= ? AND c.day <= ? AND c.count > 0
     GROUP BY c.user_id ORDER BY score DESC, c.user_id ASC LIMIT ?`,
    [Number(chatId), from, to, limit],
  );
}

/** Top members across every group of this bot for a period (Global board). Names use the latest known name. */
export async function globalLeaderboardRows(db, period, limit = 10, now = nowSec()) {
  const { from, to } = periodRange(period, now);
  return db.all(
    `SELECT c.user_id AS user_id, SUM(c.count) AS score,
       (SELECT g.username FROM group_members g WHERE g.user_id = c.user_id ORDER BY g.last_seen DESC LIMIT 1) AS username,
       (SELECT g.first_name FROM group_members g WHERE g.user_id = c.user_id ORDER BY g.last_seen DESC LIMIT 1) AS first_name
     FROM group_daily_counts c
     WHERE c.day >= ? AND c.day <= ? AND c.count > 0
     GROUP BY c.user_id ORDER BY score DESC, c.user_id ASC LIMIT ?`,
    [from, to, limit],
  );
}
