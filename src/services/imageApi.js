// Client for the separate image service (image.py on Vercel): leaderboard and couple pictures.
// The bot sends avatars as base64 inside the request, so the Telegram bot token never leaves this worker.
// Every call has a timeout, and the returned bytes are checked for type and size before the bot sends them.
import { sleep } from '../utils/helpers.js';

export const IMAGE_TIMEOUT_MS = 15000;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MIN_IMAGE_BYTES = 512;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export class ImageApiError extends Error {}

export function imageApiReady(config) {
  return Boolean(config.imageApiUrl);
}

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Profile picture of a user as base64 JPEG, or null when the user has none (the image service then draws a default). */
export async function fetchAvatar(ctx, userId) {
  try {
    const photos = await ctx.tg.call('getUserProfilePhotos', { user_id: Number(userId), limit: 1 });
    const sizes = photos?.photos?.[0];
    if (!sizes?.length) return null;
    const file = sizes[sizes.length - 1];
    const info = await ctx.tg.call('getFile', { file_id: file.file_id });
    if (!info?.file_path) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${ctx.config.botToken}/${info.file_path}`);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) return null;
    return toBase64(bytes);
  } catch {
    return null;
  }
}

/**
 * Asks the image service for a picture. Returns { bytes, type }. Throws ImageApiError with a user-safe reason.
 * Retries once on a temporary failure (network error, timeout or HTTP 5xx).
 */
export async function renderImage(ctx, path, body) {
  if (!imageApiReady(ctx.config)) throw new ImageApiError('The image service is not set up yet (IMAGE_API_URL is missing).');
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${ctx.config.imageApiUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(ctx.config.imageApiKey ? { 'x-image-key': ctx.config.imageApiKey } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      });
      if (res.status >= 500 && attempt === 1) { lastError = new ImageApiError(`image service HTTP ${res.status}`); await sleep(800); continue; }
      if (!res.ok) throw new ImageApiError(`The image service answered HTTP ${res.status}.`);
      const type = (res.headers.get('content-type') || '').split(';')[0].trim();
      if (type !== 'image/png' && type !== 'image/jpeg') throw new ImageApiError(`The image service returned an unexpected type (${type || 'none'}).`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length < MIN_IMAGE_BYTES || bytes.length > MAX_IMAGE_BYTES) throw new ImageApiError(`The generated image has an invalid size (${bytes.length} bytes).`);
      return { bytes, type };
    } catch (e) {
      if (e instanceof ImageApiError && !/HTTP 5/.test(e.message) && !/timed out|aborted|fetch/i.test(String(e.message))) throw e;
      lastError = e instanceof ImageApiError ? e : new ImageApiError(e?.name === 'TimeoutError' ? 'The image service timed out.' : 'The image service could not be reached.');
      if (attempt === 2) break;
      await sleep(800);
    }
  }
  throw lastError || new ImageApiError('The image service failed.');
}
