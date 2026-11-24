// Rules and blacklist.

import { getGroup } from '../../database/groups.js';
import { addBlacklist, countBlacklist, listBlacklist, removeBlacklist } from '../../database/groupMod.js';
import { deleteGroupSetting, getGroupSetting, setGroupSetting } from '../../database/settings.js';
import { esc, field, messages } from '../../utils/formatter.js';
import { safeJsonParse } from '../../utils/helpers.js';
import { reply } from '../../handlers/helpers.js';
import { contentFromMessage, describeContent, sendContent } from './content.js';
import { loadSettings } from './settings.js';
import { durationInRange, formatDuration, parseDuration, senderRight, DURATION_HELP } from './util.js';
import { boxHtml } from '../../ui/design.js';

async function adminGate(ctx, msg) {
  const sr = await senderRight(ctx, msg, null);
  return sr.ok ? null : reply(ctx, msg, sr.error);
}

// ---------------------------------------------------------------- rules
export async function getRules(ctx, group) {
  return safeJsonParse(await getGroupSetting(ctx.db, group, 'rules.content', null), null);
}

export async function sendRules(ctx, chat, group, { replyTo = null, user = null } = {}) {
  const rules = await getRules(ctx, group);
  if (!rules) return null;
  return sendContent(ctx, chat.id, rules, { replyTo, vars: { user, chat } });
}

export async function rulesCommand(ctx, msg) {
  const group = await getGroup(ctx.db, msg.chat.id);
  const sent = await sendRules(ctx, msg.chat, group, { replyTo: msg.message_id, user: msg.from });
  if (!sent) return reply(ctx, msg, `${boxHtml("📜", "Rules")}\n\nThis group has not set any rules yet.\nAdmins can set them with <code>/setrules &lt;text&gt;</code>.`);
  return undefined;
}

export async function setrulesCommand(ctx, msg, args, cmd) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const group = await getGroup(ctx.db, msg.chat.id);
  const built = contentFromMessage(msg, { argsStart: cmd.argsStart });
  if (!built.ok) return reply(ctx, msg, built.error === 'empty' ? messages.usage(['/setrules <text>', '/setrules (reply to a message)'], ['/setrules Please respect all members.'], 'Formatting and buttons are kept.') : built.error);
  await setGroupSetting(ctx.db, group, 'rules.content', JSON.stringify(built.content));
  return reply(ctx, msg, `${boxHtml("📜", "Rules updated successfully!")}\n\n${field('📦', 'Content', describeContent(built.content))}\n\nMembers can read them with /rules.`);
}

export async function clearrulesCommand(ctx, msg) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const group = await getGroup(ctx.db, msg.chat.id);
  const had = await deleteGroupSetting(ctx.db, group, 'rules.content');
  return reply(ctx, msg, had ? messages.success('Rules Removed', 'This group no longer has rules set.') : messages.warning('No Rules', 'There were no rules to remove.'));
}

// ---------------------------------------------------------------- blacklist
const MAX_BLACKLIST = 200;
export const BL_MODES = ['delete', 'warn', 'mute', 'kick', 'ban'];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Returns the first blacklist entry found in `text` as a WHOLE word / phrase (case-insensitive), or null.
 * Whole-word matching keeps normal conversation safe ("class" does not match "ass").
 */
export function matchBlacklist(entries, text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  for (const e of entries) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(e.pattern)}(?![\\p{L}\\p{N}_])`, 'u');
    if (re.test(t)) return e.pattern;
  }
  return null;
}

const parseEntries = (args) => [...new Set(args.split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean))];

export async function addblacklistCommand(ctx, msg, args) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const group = await getGroup(ctx.db, msg.chat.id);
  const entries = parseEntries(args);
  if (!entries.length) return reply(ctx, msg, messages.usage(['/addblacklist <word or phrase>[, another]'], ['/addblacklist spamword, bad phrase'], 'Whole words/phrases are matched, ignoring case.'));
  if (entries.some((e) => e.length > 64)) return reply(ctx, msg, messages.warning('Entry Too Long', 'Each entry can be at most 64 characters.'));
  if (entries.some((e) => e.length < 2)) return reply(ctx, msg, messages.warning('Entry Too Short', 'Entries must be at least 2 characters to avoid blocking normal chat.'));
  let total = await countBlacklist(ctx.db, group);
  const added = [];
  for (const e of entries) {
    if (total >= MAX_BLACKLIST) break;
    if (await addBlacklist(ctx.db, group, e, msg.from.id)) { added.push(e); total++; }
  }
  await setGroupSetting(ctx.db, group, 'bl.n', await countBlacklist(ctx.db, group));
  if (!added.length) return reply(ctx, msg, messages.warning('Nothing Added', total >= MAX_BLACKLIST ? `The blacklist is full (${MAX_BLACKLIST}).` : 'Those entries are already blacklisted.'));
  return reply(ctx, msg, `${boxHtml("🚫", "Blacklist updated")}\n\n${field('➕', 'Added', added.map(esc).join(', '), { raw: true })}\n${field('📋', 'Total entries', total)}`);
}

export async function rmblacklistCommand(ctx, msg, args) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const group = await getGroup(ctx.db, msg.chat.id);
  const entries = parseEntries(args);
  if (!entries.length) return reply(ctx, msg, messages.usage(['/rmblacklist <word or phrase>'], ['/rmblacklist spamword']));
  const removed = [];
  for (const e of entries) if (await removeBlacklist(ctx.db, group, e)) removed.push(e);
  await setGroupSetting(ctx.db, group, 'bl.n', await countBlacklist(ctx.db, group));
  if (!removed.length) return reply(ctx, msg, messages.warning('Not Found', 'None of those entries were blacklisted.'));
  return reply(ctx, msg, `${boxHtml("✅", "Blacklist updated")}\n\n${field('➖', 'Removed', removed.map(esc).join(', '), { raw: true })}`);
}

export async function blacklistedCommand(ctx, msg) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const group = await getGroup(ctx.db, msg.chat.id);
  const rows = await listBlacklist(ctx.db, group);
  const s = await loadSettings(ctx, group);
  if (!rows.length) return reply(ctx, msg, `${boxHtml("🚫", "Blacklist")}\n\nNo entries yet. Add some with <code>/addblacklist word</code>.`);
  return reply(ctx, msg, `🚫 <b>Blacklisted words</b> (${rows.length})\n\n${rows.map((r) => `• <code>${esc(r.pattern)}</code>`).join('\n')}\n\n${field('⚡', 'Action', s.get('bl.mode'))}`);
}

/** /blacklist — no argument lists the entries; with arguments it adds them. */
export async function blacklistCommand(ctx, msg, args, cmd) {
  if (args.trim()) return addblacklistCommand(ctx, msg, args, cmd);
  return blacklistedCommand(ctx, msg);
}

export async function blacklistmodeCommand(ctx, msg, args) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const group = await getGroup(ctx.db, msg.chat.id);
  const [mode, durToken] = args.trim().toLowerCase().split(/\s+/);
  const s = await loadSettings(ctx, group);
  if (!mode) return reply(ctx, msg, `${boxHtml("⚙️", "Blacklist Action")}\n\n${field('⚡', 'Current', s.get('bl.mode'))}\n\nChange: <code>/blacklistmode delete|warn|mute|kick|ban</code>\n• <b>delete</b> removes the message only\n• the others delete it AND punish the sender`);
  if (!BL_MODES.includes(mode)) return reply(ctx, msg, messages.usage(['/blacklistmode <delete|warn|mute|kick|ban> [duration]'], ['/blacklistmode mute 1h'], DURATION_HELP));
  let dur = s.int('bl.time');
  if (durToken) {
    dur = parseDuration(durToken);
    if (dur === null || !durationInRange(dur)) return reply(ctx, msg, messages.warning('Invalid Duration', DURATION_HELP));
  }
  await setGroupSetting(ctx.db, group, 'bl.mode', mode);
  await setGroupSetting(ctx.db, group, 'bl.time', dur);
  return reply(ctx, msg, `${boxHtml("✅", "BLACKLIST ACTION UPDATED")}\n\n${field('⚡', 'Action', mode)}${['mute', 'ban'].includes(mode) ? `\n${field('⏰', 'Duration', formatDuration(dur))}` : ''}`);
}
