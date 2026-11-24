// Webhook setup, verification and removal for one clone bot. Every call uses that clone's own token and URL.
import { decryptSecret } from '../../core/cloneCrypto.js';
import { Telegram } from '../../services/telegram.js';
import { getBotSetting } from '../../database/settings.js';

export const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query', 'chat_member', 'my_chat_member', 'channel_post'];

/** Removes anything that looks like a bot token from an error text before it is stored or shown. */
export function safeError(text) {
  return String(text || 'unknown error').replace(/\d{5,}:[A-Za-z0-9_-]{20,}/g, '[token]').slice(0, 200);
}

export async function cloneWebhookUrl(db, id) {
  const base = await getBotSetting(db, 'public_base_url', '');
  return base ? `${base.replace(/\/+$/, '')}/webhook/clone/${Number(id)}` : '';
}

/** Sets the clone's webhook, then reads it back from Telegram. Returns { ok, url, error }. */
export async function setAndVerifyCloneWebhook(mainCtx, id, token, secret) {
  const url = await cloneWebhookUrl(mainCtx.db, id);
  if (!url) return { ok: false, url: '', error: 'The public address of the main bot is not saved yet. The owner must open /setup on the main bot once.' };
  const tg = new Telegram(token);
  try {
    await tg.call('setWebhook', { url, secret_token: secret, allowed_updates: ALLOWED_UPDATES, drop_pending_updates: false });
  } catch (e) {
    return { ok: false, url, error: safeError(e?.message) };
  }
  return verifyCloneWebhook(token, url);
}

/** Reads getWebhookInfo and compares the URL. Returns { ok, url, error, pending }. */
export async function verifyCloneWebhook(token, expectedUrl) {
  const tg = new Telegram(token);
  try {
    const info = await tg.call('getWebhookInfo', {});
    const ok = info?.url === expectedUrl;
    return { ok, url: info?.url || '', pending: Number(info?.pending_update_count || 0), error: ok ? null : safeError(info?.last_error_message || 'Telegram does not have the webhook URL yet') };
  } catch (e) {
    return { ok: false, url: '', error: safeError(e?.message) };
  }
}

export async function deleteCloneWebhook(token) {
  try { await new Telegram(token).call('deleteWebhook', { drop_pending_updates: false }); return true; } catch { return false; }
}

export async function decryptToken(config, row) {
  return decryptSecret(config.cloneKey, row.token_enc);
}
