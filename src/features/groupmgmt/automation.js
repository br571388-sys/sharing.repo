// The automatic part of group management: runs for every group message BEFORE command handling.
import { logModerationLogged } from '../../core/activityLog.js';
//   service messages (joins / leaves) -> raid protection -> verification -> welcome / goodbye
//   regular messages -> antiflood -> locks -> inline-bot cleanup -> blacklist -> antispam -> filters / #notes
// Cost control: one settings query per message; blacklist / filters are only queried when entries exist; admin lookups
// (getChatMember) only happen after a rule has actually been violated.

import { getGroup } from '../../database/groups.js';
import { listBlacklist, logModeration } from '../../database/groupMod.js';
import { registerGroup } from '../groups/groupManagement.js';
import { beginVerification } from './captcha.js';
import { checkFlood, checkSpam, enforce, handleRaidJoin } from './protection.js';
import { runFilters, runNoteHashtag } from './filters.js';
import { enforceGbanOnJoin } from '../roles/gban.js';
import { goodbyeMember, welcomeNewMember } from './greetings.js';
import { matchBlacklist } from './rules.js';
import { violatedLock } from './locks.js';
import { isServiceMessage } from './cleanup.js';
import { applyRestriction } from './moderation.js';
import { loadSettings } from './settings.js';
import { isExempt, tryDelete, userLabel } from './util.js';
import { scheduleDelete } from '../../database/groupMod.js';
import { field } from '../../utils/formatter.js';
import { boxHtml } from '../../ui/design.js';

async function handleJoins(ctx, msg, group, settings) {
  const info = await ctx.botInfo();
  for (const user of (msg.new_chat_members || []).slice(0, 10)) {
    if (user.id === info.id || user.is_bot) continue;
    if (await enforceGbanOnJoin(ctx, msg.chat, user).catch(() => false)) continue; // globally banned: removed on arrival
    if (await handleRaidJoin(ctx, msg.chat, group, settings, user)) continue;
    if (settings.bool('captcha.on') && (await beginVerification(ctx, msg.chat, group, settings, user))) continue; // welcome comes after verification
    const mute = settings.int('welcome.mute');
    if (mute > 0) await applyRestriction(ctx, msg.chat, group, user.id, 'mute', { duration: mute, reason: 'Welcome mute', moderator: null });
    await welcomeNewMember(ctx, msg.chat, group, settings, user);
  }
}

/**
 * Returns true when the message has been fully handled (service message, deleted, punished, or answered by a filter)
 * and normal command processing must stop.
 */
export async function runGroupAutomation(ctx, msg) {
  const { chat } = msg;
  let group = await getGroup(ctx.db, chat.id);
  if (!group) group = (await registerGroup(ctx, chat)).group;
  const settings = await loadSettings(ctx, group);

  // ---- service messages ----
  if (isServiceMessage(msg)) {
    if (msg.new_chat_members) await handleJoins(ctx, msg, group, settings);
    if (msg.left_chat_member && !msg.left_chat_member.is_bot) await goodbyeMember(ctx, chat, group, settings, msg.left_chat_member);
    if (settings.bool('clean.service')) await tryDelete(ctx, chat.id, msg.message_id);
    return true;
  }

  const sender = msg.from;
  if (!sender || sender.is_bot || (msg.sender_chat && msg.sender_chat.id !== sender.id)) return false; // channels / anonymous admins / bots

  if (await checkFlood(ctx, msg, group, settings)) return true;

  const locked = violatedLock(msg, settings.locks());
  if (locked && !(await isExempt(ctx, chat.id, sender.id))) {
    await tryDelete(ctx, chat.id, msg.message_id);
    return true;
  }

  if (settings.bool('clean.bots') && msg.via_bot && !(await isExempt(ctx, chat.id, sender.id))) {
    await tryDelete(ctx, chat.id, msg.message_id);
    return true;
  }

  const text = msg.text ?? msg.caption;
  if (typeof text === 'string' && text && settings.int('bl.n') > 0 && !text.startsWith('/')) {
    const hit = matchBlacklist(await listBlacklist(ctx.db, group), text);
    if (hit && !(await isExempt(ctx, chat.id, sender.id))) {
      const mode = settings.get('bl.mode');
      const outcome = await enforce(ctx, chat, group, settings, msg, sender.id, mode, { reason: `Blacklisted word: ${hit}`, duration: settings.int('bl.time') });
      await logModerationLogged(ctx, group, { action: 'blacklist', target: sender.id, reason: `“${hit}” → ${outcome}`, messageId: msg.message_id, result: outcome === 'failed' ? 'failed' : 'success' });
      if (mode !== 'delete' && outcome !== 'failed') {
        const note = await ctx.tg.sendMessage(chat.id, `${boxHtml("🚫", "BLACKLISTED WORD")}\n\n${field('👤', 'User', userLabel(sender, sender.id), { raw: true })}\n${field('⚡', 'Action', outcome)}`).catch(() => null);
        if (note) await scheduleDelete(ctx.db, chat.id, note.message_id, 30).catch(() => {});
      }
      return true;
    }
  }

  if (await checkSpam(ctx, msg, group, settings)) return true;

  if (typeof msg.text === 'string' && !msg.text.startsWith('/')) {
    if (await runNoteHashtag(ctx, msg, group, settings)) return false;
    if (settings.int('flt.n') > 0 && (await runFilters(ctx, msg, group))) return false;
  } else if (typeof msg.caption === 'string' && settings.int('flt.n') > 0) {
    await runFilters(ctx, msg, group);
  }
  return false;
}
