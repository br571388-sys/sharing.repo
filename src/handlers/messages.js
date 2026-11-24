// Message handling: user/group registration, service messages, command dispatch with permissions + rate limits.

import { findCommand } from './commands.js';
import { reactOk, reply } from './helpers.js';
import { queueLog, who } from '../core/activityLog.js';
import { esc } from '../ui/escape.js';
import { parseCommand } from '../utils/command.js';
import { messages } from '../utils/formatter.js';
import { hasAccess, isBotOwner, senderOf } from '../core/permissions.js';
import { safely } from '../core/errorHandler.js';
import { upsertUser } from '../database/users.js';
import { getGroup } from '../database/groups.js';
import { hitRateLimit } from '../database/state.js';
import { bumpUsage } from '../database/roles.js';
import { onBotAdded, onBotRemoved, onGroupMigrated, registerGroup } from '../features/groups/groupManagement.js';
import { runGroupAutomation } from '../features/groupmgmt/automation.js';
import { handleAfkMessage } from '../features/groupmgmt/afkApprove.js';
import { loadSettings } from '../features/groupmgmt/settings.js';
import { relayPanelMessage } from '../features/roles/panel.js';
import { forwardUserReply } from '../features/roles/reply.js';
import { cloneStepMessage } from '../features/clones/clonebot.js';
import { handleTrollLineMessage } from '../features/couple/coupleLines.js';
import { forgetLeftMember, rememberMembers } from '../features/groupmgmt/members.js';
import { countGroupMessage } from '../features/activity/activity.js';

const isGroup = (chat) => chat.type === 'group' || chat.type === 'supergroup';

function denialText(cmd, decision, chat) {
  if (decision.reason === 'anonymous') return messages.denied('I cannot verify anonymous administrators. Turn off “Remain anonymous” and try again.');
  if (decision.reason === 'group_only') return messages.groupOnly();
  if (cmd.access === 'backup' && chat.type === 'private') {
    return messages.denied('Full backups are for the bot owner. To back up a group, run /backup inside that group (group owner only).');
  }
  if (cmd.access?.startsWith('perm:')) return messages.denied('Only the bot owner, or a captain the owner allowed for this, can use this command.');
  if (cmd.access === 'sudo') return messages.denied('This command is for bot moderators only.');
  if (cmd.access === 'owner') return messages.denied('This command is for the main owner only.');
  if (cmd.access === 'groupManage' || cmd.access === 'backup') return messages.denied('Only the group owner or an authorised administrator can use this command.');
  if (cmd.access === 'groupAdmin') return messages.denied('Only group administrators can use this command.');
  return messages.denied();
}

export async function handleMessage(ctx, msg) {
  if (!msg?.chat || msg.chat.type === 'channel') return;

  // ---- service messages ----
  if (isGroup(msg.chat)) {
    const info = await ctx.botInfo();
    if (msg.new_chat_members?.some((m) => m.id === info.id)) { await safely(ctx, 'group_added', null, () => onBotAdded(ctx, msg.chat)); return; }
    if (msg.left_chat_member?.id === info.id) { await onBotRemoved(ctx, msg.chat); return; }
    if (msg.migrate_to_chat_id) { await onGroupMigrated(ctx, msg.chat.id, msg.migrate_to_chat_id); return; }
  }

  // ---- known members of the group (for /all and /atag) ----
  if (isGroup(msg.chat)) {
    await safely(ctx, 'members', null, async () => { await rememberMembers(ctx, msg); await forgetLeftMember(ctx, msg); });
    const isService = Boolean(msg.new_chat_members || msg.left_chat_member || msg.pinned_message || msg.new_chat_title || msg.migrate_to_chat_id);
    if (!isService && msg.from && !msg.from.is_bot) await safely(ctx, 'activity', null, () => countGroupMessage(ctx.db, msg));
  }

  // ---- automatic group management (joins/leaves, locks, flood, spam, blacklist, filters) ----
  if (isGroup(msg.chat)) {
    const handled = await safely(ctx, 'group automation', null, () => runGroupAutomation(ctx, msg));
    if (handled) return;
    await safely(ctx, 'afk', null, () => handleAfkMessage(ctx, msg));
  }

  // ---- registration (private chats only: those are the users the bot can message) ----
  const sender = senderOf(msg);
  if (msg.chat.type === 'private' && msg.from && !msg.from.is_bot) await upsertUser(ctx.db, msg.from);

  // ---- clone creation steps (token, Turso URL, Turso token) are waiting for this private message ----
  if (msg.chat.type === 'private' && msg.from && !msg.from.is_bot) {
    if (await safely(ctx, 'clone step', null, () => cloneStepMessage(ctx, msg))) return;
  }

  // ---- a person's reply after tapping 💬 Reply on a message from the owner goes to the owner ----
  if (msg.chat.type === 'private' && msg.from && !msg.from.is_bot && !isBotOwner(ctx.config, msg.from.id)) {
    if (await safely(ctx, 'user reply', null, () => forwardUserReply(ctx, msg))) return;
  }

  // ---- the owner's next line for /mypartner (Bot Controls → Couple trolling lines) ----
  if (msg.chat.type === 'private' && msg.from && isBotOwner(ctx.config, msg.from.id)) {
    if (await safely(ctx, 'troll line', null, () => handleTrollLineMessage(ctx, msg))) return;
  }

  // ---- the owner's next message after a panel "Send message" goes to that moderator ----
  if (msg.chat.type === 'private' && msg.from && isBotOwner(ctx.config, msg.from.id)) {
    if (await safely(ctx, 'panel message', null, () => relayPanelMessage(ctx, msg))) return;
  }

  const text = msg.text ?? msg.caption;
  if (typeof text !== 'string') return;

  const info = await ctx.botInfo();
  const cmd = parseCommand(text, info.username);
  if (!cmd) {
    if (msg.chat.type === 'private' && msg.text && !msg.reply_to_message) {
      await reply(ctx, msg, '💡 <b>Need help?</b>\n\nSend /help to see what I can do.');
    }
    return;
  }

  const def = findCommand(cmd.name);
  if (!def) {
    if (msg.chat.type === 'private') await reply(ctx, msg, messages.warning('Unknown Command', `I don't know /${cmd.name}. Send /help to see the available commands.`));
    return;
  }

  await safely(ctx, `command /${cmd.name}`, msg.chat.id, async () => {
    if (isGroup(msg.chat)) {
      if (!(await getGroup(ctx.db, msg.chat.id))) await registerGroup(ctx, msg.chat);
    } else if (def.groupOnly) {
      await reply(ctx, msg, messages.groupOnly());
      return;
    }

    const access = isGroup(msg.chat) && def.groupAccess ? def.groupAccess : def.access;
    const decision = await hasAccess(ctx, access, msg);
    if (!decision.ok) {
      if (access === 'owner' || access === 'sudo') queueLog(ctx, `🚫 denied <code>/${esc(cmd.name)}</code> · ${who(msg.from)} · ${esc(msg.chat.title || msg.chat.type)}`);
      await reply(ctx, msg, denialText({ ...def, access }, decision, msg.chat));
      return;
    }

    if (def.rate && sender && !isBotOwner(ctx.config, sender.id)) {
      const rl = await hitRateLimit(ctx.db, `cmd:${sender.id}`, 10, 60);
      if (!rl.allowed) { await reply(ctx, msg, messages.rateLimited(rl.retryAfter)); return; }
    }

    const loggable = access !== 'public';
    if (loggable) queueLog(ctx, `⌨️ <code>/${esc(cmd.name)}</code> ${esc(String(cmd.args || '').slice(0, 80))} · ${who(msg.from)} · ${esc(msg.chat.title || msg.chat.type)}`);
    ctx._inCommand = true;
    try { await def.run(ctx, msg, cmd.args, cmd); } finally { ctx._inCommand = false; }
    await bumpUsage(ctx.db).catch(() => {});
    await reactOk(ctx, msg).catch(() => {});

    if (isGroup(msg.chat)) {
      const group = await getGroup(ctx.db, msg.chat.id);
      if (group && (await loadSettings(ctx, group)).bool('clean.commands')) await ctx.tg.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    }
  });
}
