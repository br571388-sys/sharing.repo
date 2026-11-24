// Inline-button (callback query) dispatcher. Every callback is validated and ALWAYS answered, so a button can
// never be left spinning.

import { customButtonCallback } from '../features/buttons/buttonBuilder.js';
import { menuCallback, utilityCallback } from '../features/start/start.js';
import { animeCallback } from '../features/anime/animeInfo.js';
import { scheduleCallback } from '../features/anime/animeSchedule.js';
import { imageCallback } from '../features/imageSearch/imageSearch.js';
import { broadcastCallback } from '../features/broadcast/broadcast.js';
import { importCallback } from '../features/backup/import.js';
import { dashboardCallback } from '../features/dashboard/dashboard.js';
import { panelCallback } from '../features/roles/panel.js';
import { gbanCallback } from '../features/roles/gban.js';
import { getidCallback } from '../features/roles/getid.js';
import { ownerReplyCallback, userReplyCallback } from '../features/roles/reply.js';
import { leaderboardCallback } from '../features/activity/leaderboard.js';
import { cloneCallback } from '../features/clones/clonebot.js';
import { cloneManageCallback } from '../features/clones/clonesPanel.js';
import { coupleLinesCallback } from '../features/couple/coupleLines.js';
import { buttonStyleCallback } from '../features/owner/ownerTools.js';
import { welcomeImageCallback } from '../features/start/welcomeSettings.js';
import { developerCallback } from '../features/start/start.js';
import { recordError } from '../core/errorHandler.js';
import { hitRateLimit } from '../database/state.js';
import { isBotOwner } from '../core/permissions.js';
import { GROUP_CALLBACKS } from './groupCommands.js';

const HANDLERS = {
  m: menuCallback,
  x: utilityCallback,
  an: animeCallback,
  sc: scheduleCallback,
  img: imageCallback,
  bc: broadcastCallback,
  imp: importCallback,
  dash: dashboardCallback,
  pn: panelCallback,
  gb: gbanCallback,
  bs: buttonStyleCallback,
  wi: welcomeImageCallback,
  dv: developerCallback,
  gi: getidCallback,
  ur: userReplyCallback,
  lb: leaderboardCallback,
  cl: cloneCallback,
  cm: cloneManageCallback,
  tl: coupleLinesCallback,
  ou: ownerReplyCallback,
  ...GROUP_CALLBACKS,
};

export async function handleCallback(ctx, cq) {
  let answered = false;
  const answerOnce = async (text, alert) => {
    if (answered) return;
    answered = true;
    try { await ctx.tg.answerCallbackQuery(cq.id, text, alert); } catch { /* query too old */ }
  };

  try {
    const data = String(cq.data || '');
    if (!cq.message || !cq.from || data.length > 64) return await answerOnce('This button is no longer valid.');

    // Light flood protection for everyone but the owner.
    if (!isBotOwner(ctx.config, cq.from.id)) {
      const rl = await hitRateLimit(ctx.db, `cbq:${cq.from.id}`, 40, 60).catch(() => ({ allowed: true }));
      if (!rl.allowed) return await answerOnce('Too many taps — slow down a little.');
    }

    // Wrap answerCallbackQuery so the safety net below knows whether the handler already answered.
    const original = ctx.tg.answerCallbackQuery.bind(ctx.tg);
    const tracked = Object.create(ctx.tg);
    tracked.answerCallbackQuery = (...args) => { answered = true; return original(...args); };

    if (data.startsWith('cb:')) {
      await customButtonCallback({ ...ctx, tg: tracked }, cq);
      return undefined;
    }
    const parts = data.split(':');
    const handler = HANDLERS[parts[0]];
    if (!handler) return await answerOnce('Unknown button.');
    await handler({ ...ctx, tg: tracked }, cq, parts);
    return undefined;
  } catch (err) {
    await recordError(ctx, 'callback', err);
    await answerOnce('Something went wrong. Please try again.', true);
    return undefined;
  } finally {
    if (!answered) await answerOnce();
  }
}
