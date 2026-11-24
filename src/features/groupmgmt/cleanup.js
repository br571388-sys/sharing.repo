// Cleanup switches: /cleanservice /cleancommands /cleanbots (and /selfmod). Only actions Telegram really supports:
//   * service messages (joins, leaves, pins, title/photo changes, video chats…) can be deleted by a bot with the “Delete messages” right,
//   * the bot can delete the COMMAND messages it has just handled,
//   * messages sent through INLINE bots (via_bot) are visible to the bot and can be deleted; messages that other bots
//     send normally are NOT delivered to bots by Telegram, so they cannot be cleaned.

import { getGroup } from '../../database/groups.js';
import { setGroupSetting } from '../../database/settings.js';
import { field, messages } from '../../utils/formatter.js';
import { reply } from '../../handlers/helpers.js';
import { loadSettings } from './settings.js';
import { botRightProblem, senderRight } from './util.js';

const onOff = (a) => ({ on: true, enable: true, yes: true, off: false, disable: false, no: false })[String(a || '').toLowerCase()];

function toggleCommand(name, key, { label, explain, needsDelete = true, emoji = '🧹' }) {
  return async (ctx, msg, args) => {
    const group = await getGroup(ctx.db, msg.chat.id);
    const s = await loadSettings(ctx, group);
    const a = args.trim();
    if (!a) return reply(ctx, msg, `${emoji} <b>${label}</b>\n\n${field('📌', 'Status', s.bool(key) ? '✅ Enabled' : '❌ Disabled')}\n\n${explain}\n\nUse <code>/${name} on</code> or <code>/${name} off</code>.`);
    const sr = await senderRight(ctx, msg, null);
    if (!sr.ok) return reply(ctx, msg, sr.error);
    const v = onOff(a);
    if (v === undefined) return reply(ctx, msg, messages.usage([`/${name} on|off`]));
    if (v && needsDelete) {
      const problem = await botRightProblem(ctx, msg.chat.id, 'can_delete_messages');
      if (problem) return reply(ctx, msg, problem);
    }
    await setGroupSetting(ctx.db, group, key, v ? '1' : '0');
    return reply(ctx, msg, `${emoji} <b>${label.toUpperCase()} UPDATED</b>\n\n${field('📌', 'Status', v ? 'Enabled' : 'Disabled')}`);
  };
}

export const cleanserviceCommand = toggleCommand('cleanservice', 'clean.service', { label: 'Clean Service Messages', explain: 'Deletes “X joined”, “X left”, pin notices, title / photo changes and video-chat notices.' });
export const cleancommandsCommand = toggleCommand('cleancommands', 'clean.commands', { label: 'Clean Commands', explain: 'Deletes the command message (like /rules) after the bot has handled it.' });
export const cleanbotsCommand = toggleCommand('cleanbots', 'clean.bots', { label: 'Clean Inline-Bot Messages', explain: 'Deletes messages that members post through inline bots (“via @bot”). Telegram does not show other bots\' own messages to this bot, so those cannot be cleaned.' });
export const selfmodCommand = toggleCommand('selfmod', 'selfmod.on', { label: 'Self-Moderation', explain: 'Lets members use /banme and /muteme on themselves. (/kickme is always available.)', needsDelete: false, emoji: '🙋' });

const SERVICE_KEYS = [
  'new_chat_members', 'left_chat_member', 'new_chat_title', 'new_chat_photo', 'delete_chat_photo', 'group_chat_created', 'supergroup_chat_created',
  'pinned_message', 'video_chat_started', 'video_chat_ended', 'video_chat_scheduled', 'video_chat_participants_invited', 'message_auto_delete_timer_changed',
  'forum_topic_created', 'forum_topic_closed', 'forum_topic_reopened', 'forum_topic_edited', 'boost_added',
];
export const isServiceMessage = (msg) => SERVICE_KEYS.some((k) => msg[k] !== undefined);
