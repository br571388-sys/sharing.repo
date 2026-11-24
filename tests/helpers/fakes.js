// Test doubles: fake Telegram, queue, R2, fetch routing and a ready-made context.

import { Telegram } from '../../src/services/telegram.js';
import { TelegramError } from '../../src/utils/errors.js';
import { Storage } from '../../src/services/storage.js';
import { createContext } from '../../src/core/bot.js';
import { makeDb } from './fakeDb.js';

export const OWNER = 1000;
export const BOT_ID = 999;
export const TOKEN = '999000:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';

export class FakeTelegram extends Telegram {
  constructor() {
    super(TOKEN);
    this.calls = [];
    this.nextId = 100;
    this.members = new Map(); // `${chat}:${user}` -> member object
    this.admins = new Map(); // chat -> [member]
    this.files = new Map(); // file_id -> text
    this.failures = []; // [{ match(method, params) -> bool, error }]
    this.webhook = { url: '', pending_update_count: 0 };
    this.privateBlocked = new Set();
  }

  setMember(chatId, userId, status, extra = {}) {
    this.members.set(`${chatId}:${userId}`, { status, user: { id: userId }, ...extra });
  }

  failWhen(match, error) { this.failures.push({ match, error }); }

  sent(method) { return this.calls.filter((c) => c.method === method); }
  last(method) { const l = this.sent(method); return l[l.length - 1]; }
  texts() { return this.sent('sendMessage').map((c) => String(c.params.text).normalize('NFKC')); }
  reset() { this.calls = []; }

  async call(method, params = {}) {
    const isForm = params instanceof FormData;
    const record = { method, params: isForm ? Object.fromEntries([...params.entries()].filter(([k]) => k !== 'document')) : params };
    if (isForm) record.document = params.get('document');
    this.calls.push(record);

    for (const f of this.failures) {
      if (f.match(method, record.params)) throw f.error;
    }
    const chat = Number.isNaN(Number(record.params.chat_id)) ? record.params.chat_id : Number(record.params.chat_id);
    if (typeof chat === 'number' && this.privateBlocked.has(chat) && ['sendMessage', 'copyMessage', 'sendPhoto', 'sendDocument'].includes(method)) {
      throw new TelegramError('Forbidden: bot was blocked by the user', { status: 403, method });
    }
    record.chatId = chat;
    // An edit changes the earlier message it targets, so tests see the message as the user does (edited in place).
    if (/^edit/.test(method) && record.params.message_id) {
      const target = [...this.calls].reverse().find((c) => c !== record && c.msgId === record.params.message_id && c.chatId === chat);
      if (target) for (const k of ['text', 'caption', 'reply_markup']) if (k in record.params) target.params[k] = record.params[k];
    }
    switch (method) {
      case 'getMe': return { id: BOT_ID, is_bot: true, username: 'NobaraTestBot', can_join_groups: true };
      case 'sendMessage': case 'copyMessage': { const r = { message_id: ++this.nextId, chat: { id: chat } }; record.msgId = r.message_id; return r; }
      case 'sendPhoto': { const r = { message_id: ++this.nextId, chat: { id: chat }, photo: [{ file_id: `photo-${this.nextId}` }] }; record.msgId = r.message_id; return r; }
      case 'sendDocument': return { message_id: ++this.nextId, document: { file_id: `doc-${this.nextId}` } };
      case 'getChatMember': return this.members.get(`${chat}:${record.params.user_id}`) || { status: 'left', user: { id: record.params.user_id } };
      case 'getChatAdministrators': return this.admins.get(chat) || [...this.members.entries()].filter(([k, m]) => k.startsWith(`${chat}:`) && ['administrator', 'creator'].includes(m.status)).map(([, m]) => m);
      case 'getChat': return { id: chat, type: 'supergroup', title: 'Test Group', permissions: { can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true, can_send_videos: true, can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true, can_add_web_page_previews: true, can_invite_users: true } };
      case 'getChatMemberCount': return this.members.size || 2;
      case 'banChatMember': this.setMember(chat, record.params.user_id, 'kicked'); return true;
      case 'unbanChatMember': { const cur = this.members.get(`${chat}:${record.params.user_id}`); if (cur?.status === 'kicked') this.setMember(chat, record.params.user_id, 'left'); return true; }
      case 'restrictChatMember': { const p = record.params.permissions || {}; this.setMember(chat, record.params.user_id, 'restricted', { can_send_messages: p.can_send_messages !== false, until_date: record.params.until_date || 0 }); return true; }
      case 'promoteChatMember': { const { chat_id, user_id, ...rights } = record.params; const any = Object.values(rights).some(Boolean); this.setMember(chat, user_id, any ? 'administrator' : 'member', any ? { ...rights, can_be_edited: true } : {}); return true; }
      case 'exportChatInviteLink': return 'https://t.me/+testinvite';
      case 'getWebhookInfo': return { ...this.webhook };
      case 'setWebhook': this.webhook = { ...this.webhook, url: record.params.url, has_custom_certificate: false }; return true;
      case 'getFile': return { file_id: record.params.file_id, file_path: `files/${record.params.file_id}`, file_size: (this.files.get(record.params.file_id) || '').length };
      default: return true;
    }
  }

  async downloadText(fileId, maxBytes) {
    const text = this.files.get(fileId);
    if (text === undefined) throw new TelegramError('file not found');
    if (text.length > maxBytes) throw new TelegramError('FILE_TOO_LARGE');
    return { text, size: text.length, path: `files/${fileId}` };
  }
}

export class FakeQueue {
  constructor() { this.messages = []; }
  async send(body, opts) { this.messages.push({ body, opts }); }
}

export class FakeBucket {
  constructor() { this.objects = new Map(); }
  async put(key, body) {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    this.objects.set(key, bytes);
  }
  async head(key) { const b = this.objects.get(key); return b ? { size: b.length } : null; }
  async get(key) {
    const b = this.objects.get(key);
    return b ? { body: b, text: async () => new TextDecoder().decode(b) } : null;
  }
  async delete(keys) { for (const k of [].concat(keys)) this.objects.delete(k); }
  async list({ prefix = '' } = {}) {
    const objects = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: this.objects.get(key).length }));
    return { objects, truncated: false };
  }
}

export const baseEnv = (extra = {}) => ({
  BOT_TOKEN: TOKEN,
  OWNER_ID: String(OWNER),
  BOT_NAME: 'Nobara',
  WEBHOOK_SECRET: 'whsecret_123',
  SETUP_SECRET: 'setup-secret-very-long-1234',
  TURSO_DATABASE_URL: 'libsql://test-db.turso.io',
  TURSO_AUTH_TOKEN: 'turso-token-abc',
  BACKUP_INTERVAL: 'daily',
  BROADCAST_CHUNK_SIZE: '5',
  REACTIONS: 'false',
  ...extra,
});

/** Builds a context wired to a fake DB / Telegram. Returns { ctx, db, tg, env, queue, bucket }. */
export async function makeCtx({ env = {}, withQueue = true, withR2 = false, migrate = true } = {}) {
  const db = await makeDb({ migrate });
  const tg = new FakeTelegram();
  const queue = withQueue ? new FakeQueue() : null;
  const bucket = withR2 ? new FakeBucket() : null;
  const fullEnv = baseEnv(env);
  if (queue) fullEnv.BROADCAST_QUEUE = queue;
  if (bucket) fullEnv.BACKUPS = bucket;
  const ctx = createContext(fullEnv, { waitUntil() {} }, { db, tg, storage: new Storage(bucket), botInfo: { id: BOT_ID, username: 'NobaraTestBot' } });
  return { ctx, db, tg, env: fullEnv, queue, bucket };
}

/** Telegram-like message builders. */
let msgId = 1;
export const privateMsg = (userId, text, extra = {}) => ({
  message_id: ++msgId, date: 0, chat: { id: userId, type: 'private' }, from: { id: userId, first_name: `U${userId}`, username: `user${userId}` }, text, ...extra,
});
export const groupMsg = (chatId, userId, text, extra = {}) => ({
  message_id: ++msgId, date: 0, chat: { id: chatId, type: 'supergroup', title: `Group ${chatId}` }, from: { id: userId, first_name: `U${userId}` }, text, ...extra,
});
export const update = (body) => ({ update_id: Math.floor(Math.random() * 1e9), ...body });
export const callbackQuery = (from, message, data) => ({ id: `cq${++msgId}`, from: { id: from, first_name: 'X' }, message, data });

/** Temporarily replaces global fetch. routes: [[matcher, responder]]. Returns { calls, restore }. */
export function stubFetch(routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const [match, respond] of routes) {
      if (typeof match === 'string' ? u.includes(match) : match(u, init)) {
        const r = typeof respond === 'function' ? await respond(u, init) : respond;
        if (r instanceof Response) return r;
        return new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response('not stubbed: ' + u, { status: 599 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** The last picture / GIF / video sent to the user, whether it was sent new or the /start emoji was converted into it. */
export function welcomePic(tg) {
  const c = [...tg.calls].reverse().find((x) => ['sendPhoto', 'sendAnimation', 'sendVideo', 'editMessageMedia'].includes(x.method));
  if (!c) return undefined;
  if (c.method !== 'editMessageMedia') return c;
  const m = c.params.media;
  return { method: `send${m.type[0].toUpperCase()}${m.type.slice(1)}`, params: { [m.type]: m.media, photo: m.type === 'photo' ? m.media : undefined, caption: m.caption, reply_markup: c.params.reply_markup } };
}
