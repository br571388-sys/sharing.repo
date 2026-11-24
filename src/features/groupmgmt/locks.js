// Lock system: /lock /unlock /locks /locktypes /lockall /unlockall (+ /cleanlinks alias).
import { logModerationLogged } from '../../core/activityLog.js';
//
// Enforcement strategy (documented in the README):
//   * photo, video, document, audio, voice, videonote, poll are enforced with Telegram's NATIVE chat permissions
//     (members simply cannot send them) AND by deletion as a safety net,
//   * everything else (text, links, forwards, stickers, gifs, contacts, locations, games, inline bots, other) cannot be
//     expressed as a chat permission without blocking unrelated message types, so those are enforced by deleting
//     the message (the bot needs the “Delete messages” right).
// Administrators and the group owner are never affected.

import { getGroup } from '../../database/groups.js';
import { logModeration } from '../../database/groupMod.js';
import { setGroupSetting } from '../../database/settings.js';
import { field, messages } from '../../utils/formatter.js';
import { reply } from '../../handlers/helpers.js';
import { defaultPermissions } from './moderation.js';
import { loadSettings } from './settings.js';
import { botRightProblem, senderRight } from './util.js';
import { boxHtml } from '../../ui/design.js';

export const LOCK_TYPES = {
  text: 'Text messages', links: 'Links', forward: 'Forwarded messages', photo: 'Photos', video: 'Videos', document: 'Documents',
  sticker: 'Stickers', animation: 'GIFs / animations', audio: 'Audio / music files', voice: 'Voice messages', videonote: 'Video notes',
  poll: 'Polls', contact: 'Contacts', location: 'Locations', game: 'Games', inline: 'Inline-bot messages', other: 'Other (dice, venues, invoices)',
};

const ALIASES = { gif: 'animation', gifs: 'animation', animations: 'animation', music: 'audio', forwards: 'forward', forwarded: 'forward', link: 'links', url: 'links', urls: 'links', photos: 'photo', videos: 'video', documents: 'document', docs: 'document', file: 'document', files: 'document', stickers: 'sticker', voices: 'voice', videonotes: 'videonote', video_note: 'videonote', polls: 'poll', contacts: 'contact', locations: 'location', games: 'game', inlinebots: 'inline', inlinebot: 'inline', bots: 'inline' };
export const GROUPS = { media: ['photo', 'video', 'document', 'animation', 'audio', 'voice', 'videonote', 'sticker'] };

/** Types backed by a native Telegram permission. */
const NATIVE = { photo: 'can_send_photos', video: 'can_send_videos', document: 'can_send_documents', audio: 'can_send_audios', voice: 'can_send_voice_notes', videonote: 'can_send_video_notes', poll: 'can_send_polls' };

/** Normalises user input into a list of valid lock types ('media' and 'all' expand). Returns { types, invalid }. */
export function parseLockTypes(input) {
  const types = new Set();
  const invalid = [];
  for (const raw of String(input).toLowerCase().split(/[\s,]+/).filter(Boolean)) {
    const word = ALIASES[raw] || raw;
    if (word === 'all') Object.keys(LOCK_TYPES).forEach((t) => types.add(t));
    else if (GROUPS[word]) GROUPS[word].forEach((t) => types.add(t));
    else if (LOCK_TYPES[word]) types.add(word);
    else invalid.push(raw);
  }
  return { types: [...types], invalid };
}

const URL_RE = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|me|ly|gg|xyz|info|co|in|ru|tk|ml|ga|cf|gq|link|site|online|top|club|app|dev)\b\/?\S*/i;

/** Which lock types does this message belong to? */
export function messageTypes(msg) {
  const t = new Set();
  const text = msg.text ?? msg.caption ?? '';
  const entities = msg.entities || msg.caption_entities || [];
  if (typeof msg.text === 'string' && !msg.text.startsWith('/')) t.add('text');
  if (entities.some((e) => e.type === 'url' || e.type === 'text_link') || (text && URL_RE.test(text))) t.add('links');
  if (msg.forward_origin || msg.forward_date || msg.forward_from || msg.forward_from_chat) t.add('forward');
  if (msg.photo) t.add('photo');
  if (msg.video) t.add('video');
  if (msg.animation) t.add('animation');
  else if (msg.document) t.add('document');
  if (msg.sticker) t.add('sticker');
  if (msg.audio) t.add('audio');
  if (msg.voice) t.add('voice');
  if (msg.video_note) t.add('videonote');
  if (msg.poll) t.add('poll');
  if (msg.contact) t.add('contact');
  if (msg.location && !msg.venue) t.add('location');
  if (msg.game) t.add('game');
  if (msg.via_bot) t.add('inline');
  if (msg.dice || msg.venue || msg.invoice) t.add('other');
  return t;
}

/** The first locked type this message violates, or null. */
export function violatedLock(msg, locks) {
  if (!locks.size) return null;
  for (const type of messageTypes(msg)) if (locks.has(type)) return type;
  return null;
}

async function applyNativePermissions(ctx, chatId, types, locked) {
  const native = types.filter((t) => NATIVE[t]);
  if (!native.length) return { applied: false };
  const problem = await botRightProblem(ctx, chatId, 'can_restrict_members');
  if (problem) return { applied: false, problem: 'missing right' };
  try {
    const perms = await defaultPermissions(ctx, chatId);
    for (const t of native) perms[NATIVE[t]] = !locked;
    await ctx.tg.setChatPermissions(chatId, perms);
    return { applied: true };
  } catch (e) {
    return { applied: false, problem: String(e?.message).slice(0, 80) };
  }
}

/** Stores the locks, applies native permissions where possible and logs it. Used by commands AND the settings menu. */
export async function applyLocks(ctx, chat, userId, types, locked) {
  const group = await getGroup(ctx.db, chat.id);
  for (const t of types) await setGroupSetting(ctx.db, group, `lock.${t}`, locked ? '1' : '0');
  const native = await applyNativePermissions(ctx, chat.id, types, locked);
  await logModerationLogged(ctx, group, { action: locked ? 'lock' : 'unlock', moderator: userId, reason: types.join(', ') });
  const delProblem = locked ? await botRightProblem(ctx, chat.id, 'can_delete_messages') : null;
  return { native, delProblem };
}

async function setLocks(ctx, msg, types, locked) {
  const { native, delProblem } = await applyLocks(ctx, msg.chat, msg.from.id, types, locked);
  const names = types.length > 4 ? `${types.slice(0, 4).map((t) => LOCK_TYPES[t]).join(', ')} +${types.length - 4} more` : types.map((t) => LOCK_TYPES[t]).join(', ');
  const lines = [
    `${locked ? '🔒' : '🔓'} <b>GROUP LOCK UPDATED</b>`, '',
    field('📌', 'Type', names),
    field('✅', 'Status', locked ? 'Enabled' : 'Disabled'),
  ];
  if (locked && native.applied) lines.push(field('🛡️', 'Enforcement', 'Telegram permissions + deletion'));
  else if (locked) lines.push(field('🛡️', 'Enforcement', 'message deletion'));
  if (locked && delProblem) lines.push('', '⚠️ I cannot delete messages yet — give me the “Delete messages” admin right for these locks to take effect.');
  return reply(ctx, msg, lines.join('\n'));
}

async function lockUnlock(ctx, msg, args, locked) {
  const sr = await senderRight(ctx, msg, null);
  if (!sr.ok) return reply(ctx, msg, sr.error);
  const word = locked ? 'lock' : 'unlock';
  if (!args.trim()) return reply(ctx, msg, messages.usage([`/${word} <type> [type…]`], [`/${word} links`, `/${word} media`], 'See /locktypes for every type.'));
  const { types, invalid } = parseLockTypes(args);
  if (invalid.length) return reply(ctx, msg, messages.warning('Unknown Lock Type', `“${invalid.slice(0, 3).join(', ')}” is not a lock type. Send /locktypes to see them all.`));
  return setLocks(ctx, msg, types, locked);
}

export const lockCommand = (ctx, msg, args) => lockUnlock(ctx, msg, args, true);
export const unlockCommand = (ctx, msg, args) => lockUnlock(ctx, msg, args, false);
export const lockallCommand = (ctx, msg) => lockUnlock(ctx, msg, 'all', true);
export const unlockallCommand = (ctx, msg) => lockUnlock(ctx, msg, 'all', false);
export const cleanlinksCommand = async (ctx, msg, args) => {
  const a = args.trim().toLowerCase();
  if (a === 'on' || a === 'off') return lockUnlock(ctx, msg, 'links', a === 'on');
  const group = await getGroup(ctx.db, msg.chat.id);
  const on = (await loadSettings(ctx, group)).locks().has('links');
  return reply(ctx, msg, `${boxHtml("🔗", "Clean Links")}\n\n${field('📌', 'Link messages from members are', on ? 'deleted' : 'allowed')}\n\nUse <code>/cleanlinks on|off</code> (same as /lock links).`);
};

export async function locksCommand(ctx, msg) {
  const group = await getGroup(ctx.db, msg.chat.id);
  const locks = (await loadSettings(ctx, group)).locks();
  const lines = Object.entries(LOCK_TYPES).map(([t, label]) => `${locks.has(t) ? '🔒' : '🔓'} ${label} — <code>${t}</code>`);
  return reply(ctx, msg, `${boxHtml("🔒", "Group Locks")}\n\n${lines.join('\n')}\n\n${field('📊', 'Active locks', locks.size)}`);
}

export async function locktypesCommand(ctx, msg) {
  const lines = Object.entries(LOCK_TYPES).map(([t, label]) => `• <code>${t}</code> — ${label}`);
  return reply(ctx, msg, `${boxHtml("🔒", "Lock Types")}\n\n${lines.join('\n')}\n\n<b>Shortcuts</b>\n• <code>media</code> — photo, video, document, animation, audio, voice, videonote, sticker\n• <code>all</code> — every type\n\nExample: <code>/lock links stickers</code>`);
}
