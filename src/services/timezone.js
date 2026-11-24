// Asia/Kolkata (IST, UTC+05:30, no DST) helpers. All schedule times are shown in IST.

export const TIMEZONE = 'Asia/Kolkata';
export const IST_OFFSET_SEC = 19800;
const DAY = 86400;

const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: true });
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'short', day: '2-digit', month: 'short' });
const shortDayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'short', day: 'numeric' });
const fullFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
});

const clean = (s) => s.replace(/[  ]/g, ' ');

/** "08:30 PM IST" */
export function formatTimeIST(unixSec) {
  return `${clean(timeFmt.format(new Date(unixSec * 1000)))} IST`;
}

/** "Sat, Nov 14" */
export function formatDayIST(unixSec) {
  return clean(dayFmt.format(new Date(unixSec * 1000)));
}

/** "Sat 14" (for buttons) */
export function formatShortDayIST(unixSec) {
  return clean(shortDayFmt.format(new Date(unixSec * 1000))).replace(',', '');
}

/** "14 Nov 2026, 08:30 PM IST" */
export function formatDateTimeIST(unixSec) {
  return `${clean(fullFmt.format(new Date(unixSec * 1000)))} IST`;
}

/** Unix timestamp of 00:00 IST for the day containing `unixSec`, shifted by `offsetDays`. */
export function istDayStart(unixSec = Math.floor(Date.now() / 1000), offsetDays = 0) {
  const start = Math.floor((unixSec + IST_OFFSET_SEC) / DAY) * DAY - IST_OFFSET_SEC;
  return start + offsetDays * DAY;
}

export function istDayRange(offsetDays = 0, unixSec = Math.floor(Date.now() / 1000)) {
  const from = istDayStart(unixSec, offsetDays);
  return { from, to: from + DAY };
}

/** Human countdown computed at render time (never stored): "2d 4h", "35m", "airing now". */
export function formatCountdown(targetSec, nowSec = Math.floor(Date.now() / 1000)) {
  const diff = targetSec - nowSec;
  if (diff <= 0) return 'aired';
  const d = Math.floor(diff / DAY);
  const h = Math.floor((diff % DAY) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(m, 1)}m`;
}
