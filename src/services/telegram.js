// Telegram Bot API client (fetch only).

import { TelegramError } from '../utils/errors.js';
import { fetchWithTimeout, sleep } from '../utils/helpers.js';

const API = 'https://api.telegram.org';

export class Telegram {
  constructor(token, { timeoutMs = 15000, onFailure = null } = {}) {
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.onFailure = onFailure; // optional (method) => void, called once for each call that finally fails
  }

  fail(err, method) {
    try { this.onFailure?.(method, err); } catch { /* counting must never break a request */ }
    return err;
  }

  /**
   * Calls a Bot API method. Throws TelegramError (with retryAfter / migrateTo when Telegram provides them).
   * `autoRetry` waits and retries once on a short 429 (good for interactive replies; broadcasts disable it).
   */
  async call(method, params = {}, { autoRetry = true, timeoutMs = this.timeoutMs } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        const isForm = params instanceof FormData;
        res = await fetchWithTimeout(`${API}/bot${this.token}/${method}`, {
          method: 'POST',
          headers: isForm ? undefined : { 'Content-Type': 'application/json' },
          body: isForm ? params : JSON.stringify(params),
        }, timeoutMs);
      } catch (e) {
        throw this.fail(new TelegramError(e?.name === 'AbortError' ? `Telegram ${method} timed out` : `Telegram ${method} network error`, { method, cause: e }), method);
      }

      let data = null;
      try { data = await res.json(); } catch { /* non-JSON body */ }
      if (data?.ok) return data.result;

      const retryAfter = data?.parameters?.retry_after;
      if (res.status === 429 && retryAfter && autoRetry && retryAfter <= 3 && attempt === 0) {
        await sleep((retryAfter + 0.2) * 1000);
        continue;
      }
      throw this.fail(new TelegramError(data?.description || `Telegram ${method} failed (HTTP ${res.status})`, {
        status: data?.error_code || res.status, method, retryAfter, migrateTo: data?.parameters?.migrate_to_chat_id,
      }), method);
    }
    throw this.fail(new TelegramError(`Telegram ${method} failed`, { method }), method);
  }

  getMe() { return this.call('getMe'); }
  sendMessage(chatId, text, extra = {}) {
    return this.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  }
  editMessageText(chatId, messageId, text, extra = {}) {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  }
  editMessageCaption(chatId, messageId, caption, extra = {}) {
    return this.call('editMessageCaption', { chat_id: chatId, message_id: messageId, caption, parse_mode: 'HTML', ...extra });
  }
  editMessageMedia(chatId, messageId, media, extra = {}) {
    return this.call('editMessageMedia', { chat_id: chatId, message_id: messageId, media, ...extra });
  }
  editMessageReplyMarkup(chatId, messageId, replyMarkup) { return this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup }); }
  deleteMessage(chatId, messageId) { return this.call('deleteMessage', { chat_id: chatId, message_id: messageId }); }
  sendPhoto(chatId, photo, extra = {}) { return this.call('sendPhoto', { chat_id: chatId, photo, parse_mode: 'HTML', ...extra }); }
  copyMessage(chatId, fromChatId, messageId, extra = {}) {
    return this.call('copyMessage', { chat_id: chatId, from_chat_id: fromChatId, message_id: messageId, ...extra }, { autoRetry: false });
  }
  answerCallbackQuery(id, text, showAlert = false, extra = {}) {
    return this.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text: String(text).slice(0, 200) } : {}), show_alert: Boolean(showAlert), ...extra });
  }
  getChatMember(chatId, userId) { return this.call('getChatMember', { chat_id: chatId, user_id: userId }); }
  getChatAdministrators(chatId) { return this.call('getChatAdministrators', { chat_id: chatId }); }
  getChat(chatId) { return this.call('getChat', { chat_id: chatId }); }
  pinChatMessage(chatId, messageId, silent = true) { return this.call('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: silent }); }
  // ---- group administration ----
  banChatMember(chatId, userId, { untilDate, revokeMessages = false } = {}) {
    return this.call('banChatMember', { chat_id: chatId, user_id: userId, ...(untilDate ? { until_date: untilDate } : {}), revoke_messages: revokeMessages });
  }
  unbanChatMember(chatId, userId, onlyIfBanned = true) {
    return this.call('unbanChatMember', { chat_id: chatId, user_id: userId, only_if_banned: onlyIfBanned });
  }
  restrictChatMember(chatId, userId, permissions, { untilDate } = {}) {
    return this.call('restrictChatMember', { chat_id: chatId, user_id: userId, permissions, use_independent_chat_permissions: true, ...(untilDate ? { until_date: untilDate } : {}) });
  }
  promoteChatMember(chatId, userId, rights) { return this.call('promoteChatMember', { chat_id: chatId, user_id: userId, ...rights }); }
  setChatAdministratorCustomTitle(chatId, userId, title) { return this.call('setChatAdministratorCustomTitle', { chat_id: chatId, user_id: userId, custom_title: title }); }
  unpinChatMessage(chatId, messageId) { return this.call('unpinChatMessage', { chat_id: chatId, ...(messageId ? { message_id: messageId } : {}) }); }
  unpinAllChatMessages(chatId) { return this.call('unpinAllChatMessages', { chat_id: chatId }); }
  getChatMemberCount(chatId) { return this.call('getChatMemberCount', { chat_id: chatId }); }
  exportChatInviteLink(chatId) { return this.call('exportChatInviteLink', { chat_id: chatId }); }
  createChatInviteLink(chatId, extra = {}) { return this.call('createChatInviteLink', { chat_id: chatId, ...extra }); }
  setChatPermissions(chatId, permissions) { return this.call('setChatPermissions', { chat_id: chatId, permissions, use_independent_chat_permissions: true }); }
  setChatTitle(chatId, title) { return this.call('setChatTitle', { chat_id: chatId, title }); }
  setChatDescription(chatId, description) { return this.call('setChatDescription', { chat_id: chatId, description }); }

  /** Sends stored media by type (photo, video, document, animation, sticker, voice, audio, video_note). */
  sendMedia(chatId, type, fileId, extra = {}) {
    const method = { photo: 'sendPhoto', video: 'sendVideo', document: 'sendDocument', animation: 'sendAnimation', sticker: 'sendSticker', voice: 'sendVoice', audio: 'sendAudio', video_note: 'sendVideoNote' }[type];
    if (!method) throw new TelegramError(`Unsupported media type ${type}`, { method: 'sendMedia' });
    const field = type === 'video_note' ? 'video_note' : type;
    const noCaption = type === 'sticker' || type === 'video_note';
    const { caption, ...rest } = extra;
    return this.call(method, { chat_id: chatId, [field]: fileId, ...(caption && !noCaption ? { caption, parse_mode: 'HTML' } : {}), ...rest });
  }

  getFile(fileId) { return this.call('getFile', { file_id: fileId }); }
  setMyCommands(commands, scope, languageCode) {
    return this.call('setMyCommands', { commands, ...(scope ? { scope } : {}), ...(languageCode ? { language_code: languageCode } : {}) });
  }
  getWebhookInfo() { return this.call('getWebhookInfo'); }
  setWebhook(params) { return this.call('setWebhook', params); }

  /** Best-effort reaction; never throws (chats may disallow reactions). */
  async react(chatId, messageId, emoji = '👍') {
    try {
      await this.call('setMessageReaction', { chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji }] }, { autoRetry: false });
      return true;
    } catch {
      return false;
    }
  }

  /** Sends a document from memory (Uint8Array / string). */
  async sendDocument(chatId, content, filename, extra = {}) {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('document', new Blob([content], { type: 'application/json' }), filename);
    for (const [k, v] of Object.entries({ parse_mode: 'HTML', ...extra })) {
      if (v === undefined || v === null) continue;
      form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    return this.call('sendDocument', form, { timeoutMs: 30000 });
  }

  /** Sends a picture generated in memory (PNG / JPEG bytes). */
  async sendPhotoBytes(chatId, bytes, caption = '', extra = {}) {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('photo', new Blob([bytes], { type: 'image/png' }), 'image.png');
    if (caption) form.set('caption', caption);
    for (const [k, v] of Object.entries({ parse_mode: 'HTML', ...extra })) {
      if (v === undefined || v === null) continue;
      form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    return this.call('sendPhoto', form, { timeoutMs: 30000 });
  }

  /** Replaces the picture of a bot message with one generated in memory (keeps the message, changes the image). */
  async editPhotoBytes(chatId, messageId, bytes, caption = '', extra = {}) {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('message_id', String(messageId));
    form.set('photo', new Blob([bytes], { type: 'image/png' }), 'image.png');
    form.set('media', JSON.stringify({ type: 'photo', media: 'attach://photo', caption, parse_mode: 'HTML' }));
    if (extra.reply_markup) form.set('reply_markup', JSON.stringify(extra.reply_markup));
    return this.call('editMessageMedia', form, { timeoutMs: 30000 });
  }

  /** Downloads a file by file_id. Rejects anything larger than `maxBytes`. Returns { text, size, path }. */
  async downloadText(fileId, maxBytes) {
    const file = await this.getFile(fileId);
    if (!file?.file_path) throw new TelegramError('Telegram did not return a file path');
    if (file.file_size && file.file_size > maxBytes) throw new TelegramError('FILE_TOO_LARGE');
    let res;
    try {
      res = await fetchWithTimeout(`${API}/file/bot${this.token}/${file.file_path}`, {}, 30000);
    } catch (e) {
      throw new TelegramError('Could not download the file from Telegram', { cause: e });
    }
    if (!res.ok) throw new TelegramError(`File download failed (HTTP ${res.status})`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) throw new TelegramError('FILE_TOO_LARGE');
    return { text: new TextDecoder('utf-8', { fatal: false }).decode(buf), size: buf.byteLength, path: file.file_path };
  }
}

/** Telegram error -> "this chat can never receive our messages" (user blocked bot, group deleted, etc.). */
export function isPermanentDeliveryError(err) {
  if (!(err instanceof TelegramError)) return false;
  const d = String(err.message || '').toLowerCase();
  return err.status === 403
    || d.includes('chat not found') || d.includes('user is deactivated') || d.includes('bot was blocked')
    || d.includes('bot was kicked') || d.includes('have no rights to send') || d.includes('chat_write_forbidden')
    || d.includes('peer_id_invalid') || d.includes('group chat was upgraded') || d.includes('not enough rights to send');
}

export function isMessageNotModified(err) {
  return err instanceof TelegramError && String(err.message).toLowerCase().includes('message is not modified');
}
