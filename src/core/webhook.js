// Telegram webhook endpoint: verify, parse, acknowledge immediately, process in the background.

import { maintenanceBlocks } from './maintenance.js';
import { routeUpdate } from './router.js';
import { recordError } from './errorHandler.js';
import { claimUpdate } from '../database/state.js';
import { getBotSetting, setBotSetting } from '../database/settings.js';
import { setButtonMode } from '../ui/typography.js';
import { flushActivityLog } from './activityLog.js';
import { isPlainObject, nowSec, timingSafeEqual } from '../utils/helpers.js';

const MAX_BODY = 1_000_000;
let lastTouch = 0;

const text = (body, status, headers = {}) => new Response(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

/** Processes one update (called inside waitUntil, or directly by tests). Never throws. */
export async function processUpdate(ctx, update) {
  try {
    if (!(await claimUpdate(ctx.db, update.update_id))) return 'duplicate';
    setButtonMode(await getBotSetting(ctx.db, 'button_style', 'block').catch(() => 'block'));
    if (nowSec() - lastTouch > 30) {
      lastTouch = nowSec();
      await setBotSetting(ctx.db, 'last_update_at', nowSec());
    }
    if (await maintenanceBlocks(ctx, update)) return 'maintenance';
    await routeUpdate(ctx, update);
    return 'processed';
  } catch (err) {
    await recordError(ctx, `update ${update?.update_id}`, err);
    return 'error';
  } finally {
    await flushActivityLog(ctx);
  }
}

export async function handleWebhook(request, ctx) {
  if (request.method !== 'POST') return text('Method Not Allowed', 405, { Allow: 'POST' });

  const given = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!ctx.config.webhookSecret || !given || !timingSafeEqual(given, ctx.config.webhookSecret)) return text('Forbidden', 403);

  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_BODY) return text('Payload Too Large', 413);

  let update;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return text('Payload Too Large', 413);
    update = JSON.parse(raw);
  } catch {
    return text('Bad Request', 400);
  }
  if (!isPlainObject(update) || !Number.isSafeInteger(update.update_id)) return text('Bad Request', 400);

  // Acknowledge right away; the work continues after the response is sent.
  ctx.waitUntil(processUpdate(ctx, update));
  return text('OK', 200);
}
