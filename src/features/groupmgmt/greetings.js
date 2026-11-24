// Group welcome / goodbye. Completely separate from the private /start welcome (bot_settings).
// Commands: /welcome /setwelcome /resetwelcome /welcomemute /welcometype /cleanwelcome and the goodbye equivalents.

import { getGroup } from '../../database/groups.js';
import { deleteGreeting, getGreeting, saveGreeting, scheduleDelete } from '../../database/groupMod.js';
import { hitRateLimit } from '../../database/state.js';
import { setGroupSetting } from '../../database/settings.js';
import { btn } from '../../keyboards/inlineKeyboard.js';
import { field, messages } from '../../utils/formatter.js';
import { reply } from '../../handlers/helpers.js';
import { applyPlaceholders, contentFromMessage, describeContent, sendContent } from './content.js';
import { getRules } from './rules.js';
import { loadSettings } from './settings.js';
import { DURATION_HELP, durationInRange, formatDuration, parseDuration, senderRight } from './util.js';
import { boxHtml } from '../../ui/design.js';

export const DEFAULT_WELCOME = { text: '👋 <b>Welcome {mention}!</b>\n\n🎉 Welcome to <b>{chatname}</b>!\n\n📜 Please read our group rules.', media: null, buttons: null };
export const DEFAULT_GOODBYE = { text: '👋 <b>{first}</b> has left <b>{chatname}</b>. Goodbye!', media: null, buttons: null };
const DEFAULTS = { welcome: DEFAULT_WELCOME, goodbye: DEFAULT_GOODBYE };
const NAME = { welcome: 'Welcome', goodbye: 'Goodbye' };

async function adminGate(ctx, msg) {
  const sr = await senderRight(ctx, msg, null);
  return sr.ok ? null : reply(ctx, msg, sr.error);
}

async function memberCountFor(ctx, chatId, content) {
  if (!/\{count\}/i.test(content.text || '')) return undefined;
  try { return await ctx.tg.getChatMemberCount(chatId); } catch { return undefined; }
}

/** Sends the group's welcome or goodbye for `user`. Returns the sent message or null. */
export async function sendGreeting(ctx, kind, chat, group, settings, user, { preview = false } = {}) {
  const content = (await getGreeting(ctx.db, group, kind)) || DEFAULTS[kind];
  const vars = { user, chat, count: await memberCountFor(ctx, chat.id, content) };
  const extraButtons = [];
  if (kind === 'welcome' && settings.bool('welcome.rules_button') && (await getRules(ctx, group))) extraButtons.push([btn('📜 Rules', 'gr:rules')]);
  const forceText = kind === 'welcome' && settings.get('welcome.type') === 'text';
  const sent = await sendContent(ctx, chat.id, content, { vars, extraButtons, forceText });
  const clean = settings.int(`${kind}.clean`);
  if (sent && clean > 0 && !preview) await scheduleDelete(ctx.db, chat.id, sent.message_id, clean).catch(() => {});
  return sent;
}

/** New member: send the welcome once per (chat, user) per minute and optionally soft-mute. */
export async function welcomeNewMember(ctx, chat, group, settings, user) {
  if (!settings.bool('welcome.on')) return null;
  if ((await hitRateLimit(ctx.db, `wel:${chat.id}:${user.id}`, 1, 60)).allowed === false) return null;
  try { return await sendGreeting(ctx, 'welcome', chat, group, settings, user); } catch { return null; }
}

export async function goodbyeMember(ctx, chat, group, settings, user) {
  if (!settings.bool('goodbye.on')) return null;
  if ((await hitRateLimit(ctx.db, `bye:${chat.id}:${user.id}`, 1, 60)).allowed === false) return null;
  try { return await sendGreeting(ctx, 'goodbye', chat, group, settings, user); } catch { return null; }
}

const onOff = (arg) => ({ on: true, enable: true, yes: true, true: true, off: false, disable: false, no: false, false: false })[String(arg || '').toLowerCase()];

function makeCommands(kind) {
  const key = `${kind}.on`;
  const label = NAME[kind];

  const toggle = async (ctx, msg, args) => {
    const group = await getGroup(ctx.db, msg.chat.id);
    const settings = await loadSettings(ctx, group);
    const arg = args.trim().toLowerCase();
    if (!arg) {
      const status = `${settings.bool(key) ? '✅ Enabled' : '❌ Disabled'}`;
      await reply(ctx, msg, `${kind === 'welcome' ? '👋' : '🚪'} <b>${label} Settings</b>\n\n${field('📌', 'Status', status)}\n${field('🧹', 'Auto-delete', settings.int(`${kind}.clean`) ? formatDuration(settings.int(`${kind}.clean`)) : 'off')}\n\nUse <code>/${kind} on|off</code>, <code>/set${kind} &lt;text&gt;</code>. Placeholders: {first} {last} {username} {mention} {id} {chatname} {count}.\n\n👇 Preview:`);
      return sendGreeting(ctx, kind, msg.chat, group, settings, msg.from, { preview: true }).catch(() => undefined);
    }
    const deny = await adminGate(ctx, msg); if (deny) return deny;
    const v = onOff(arg);
    if (v === undefined) return reply(ctx, msg, messages.usage([`/${kind} on|off`]));
    await setGroupSetting(ctx.db, group, key, v ? '1' : '0');
    return reply(ctx, msg, `${kind === 'welcome' ? '👋' : '🚪'} <b>${label} system updated successfully!</b>\n\n${field('📌', 'Status', v ? 'Enabled' : 'Disabled')}`);
  };

  const set = async (ctx, msg, args, cmd) => {
    const deny = await adminGate(ctx, msg); if (deny) return deny;
    const group = await getGroup(ctx.db, msg.chat.id);
    const built = contentFromMessage(msg, { argsStart: cmd.argsStart });
    if (!built.ok) {
      return reply(ctx, msg, built.error === 'empty'
        ? messages.usage([`/set${kind} <text> [button rows]`, `/set${kind} (reply to a message or media)`], [`/set${kind} 👋 Welcome {mention} to {chatname}!`], 'Placeholders: {first} {last} {username} {mention} {id} {chatname} {count}. Formatting, media and (Label - https://link) buttons are supported.')
        : built.error);
    }
    await saveGreeting(ctx.db, group, kind, built.content);
    await setGroupSetting(ctx.db, group, key, '1');
    await reply(ctx, msg, `${kind === 'welcome' ? '👋' : '🚪'} <b>${label} system updated successfully!</b>\n\n${field('📦', 'Content', describeContent(built.content))}\n\n👇 Preview:`);
    return sendGreeting(ctx, kind, msg.chat, group, await loadSettings(ctx, group), msg.from, { preview: true }).catch(() => reply(ctx, msg, messages.warning('Preview Failed', 'The message was saved, but Telegram could not send the preview (check media / buttons).')));
  };

  const reset = async (ctx, msg) => {
    const deny = await adminGate(ctx, msg); if (deny) return deny;
    const group = await getGroup(ctx.db, msg.chat.id);
    const had = await deleteGreeting(ctx.db, group, kind);
    return reply(ctx, msg, had ? messages.success(`${label} Reset`, `The ${kind} message was restored to the default.`) : messages.warning('Already Default', `This group already uses the default ${kind} message.`));
  };

  const clean = async (ctx, msg, args) => {
    const deny = await adminGate(ctx, msg); if (deny) return deny;
    const group = await getGroup(ctx.db, msg.chat.id);
    const arg = args.trim().toLowerCase();
    const current = (await loadSettings(ctx, group)).int(`${kind}.clean`);
    if (!arg) return reply(ctx, msg, `🧹 <b>Clean ${label}</b>\n\n${field('⏳', 'Auto-delete after', current ? formatDuration(current) : 'off')}\n\nUse <code>/clean${kind} on</code> (5 minutes), <code>/clean${kind} 10m</code> or <code>/clean${kind} off</code>.`);
    let sec;
    if (arg === 'off') sec = 0;
    else if (arg === 'on') sec = 300;
    else { sec = parseDuration(arg); if (sec === null || sec < 30 || sec > 86400) return reply(ctx, msg, messages.usage([`/clean${kind} <on|off|duration>`], [`/clean${kind} 10m`], 'From 30 seconds to 1 day.')); }
    await setGroupSetting(ctx.db, group, `${kind}.clean`, sec);
    return reply(ctx, msg, `🧹 <b>Clean ${label} updated</b>\n\n${field('⏳', 'Auto-delete after', sec ? formatDuration(sec) : 'off')}`);
  };

  return { toggle, set, reset, clean };
}

const W = makeCommands('welcome');
const G = makeCommands('goodbye');
export const welcomeCommand = W.toggle;
export const setgroupwelcomeCommand = W.set;
export const resetgroupwelcomeCommand = W.reset;
export const cleanwelcomeCommand = W.clean;
export const goodbyeCommand = G.toggle;
export const setgoodbyeCommand = G.set;
export const resetgoodbyeCommand = G.reset;
export const cleangoodbyeCommand = G.clean;

/** /welcomemute <off|duration> — new members cannot talk for that long (ignored while verification is on). */
export async function welcomemuteCommand(ctx, msg, args) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const group = await getGroup(ctx.db, msg.chat.id);
  const arg = args.trim().toLowerCase();
  const current = (await loadSettings(ctx, group)).int('welcome.mute');
  if (!arg) return reply(ctx, msg, `${boxHtml("🔇", "Welcome Mute")}\n\n${field('⏳', 'New members are muted for', current ? formatDuration(current) : 'off')}\n\nChange: <code>/welcomemute 10m</code> or <code>/welcomemute off</code>.`);
  let sec = 0;
  if (arg !== 'off') {
    sec = parseDuration(arg);
    if (sec === null || !durationInRange(sec)) return reply(ctx, msg, messages.usage(['/welcomemute <off|duration>'], ['/welcomemute 10m'], DURATION_HELP));
  }
  await setGroupSetting(ctx.db, group, 'welcome.mute', sec);
  return reply(ctx, msg, `${boxHtml("🔇", "Welcome mute updated")}\n\n${field('⏳', 'New members are muted for', sec ? formatDuration(sec) : 'off')}`);
}

/** /welcometype <auto|text> — "auto" shows the saved media with the text, "text" always sends text only. */
export async function welcometypeCommand(ctx, msg, args) {
  const deny = await adminGate(ctx, msg); if (deny) return deny;
  const group = await getGroup(ctx.db, msg.chat.id);
  const arg = args.trim().toLowerCase();
  if (!arg) return reply(ctx, msg, `${boxHtml("👋", "Welcome Type")}\n\n${field('🎛️', 'Current', (await loadSettings(ctx, group)).get('welcome.type'))}\n\n<code>/welcometype auto</code> — media + caption when media is saved\n<code>/welcometype text</code> — always text only`);
  if (!['auto', 'text'].includes(arg)) return reply(ctx, msg, messages.usage(['/welcometype <auto|text>']));
  await setGroupSetting(ctx.db, group, 'welcome.type', arg);
  return reply(ctx, msg, `${boxHtml("👋", "Welcome type updated")}\n\n${field('🎛️', 'Type', arg)}`);
}

/** Callback gr:rules — shows the rules in the group. */
export async function rulesButtonCallback(ctx, cq) {
  const chat = cq.message?.chat;
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) return ctx.tg.answerCallbackQuery(cq.id, 'Groups only.', true);
  const group = await getGroup(ctx.db, chat.id);
  const { sendRules } = await import('./rules.js');
  const sent = await sendRules(ctx, chat, group, { user: cq.from }).catch(() => null);
  return ctx.tg.answerCallbackQuery(cq.id, sent ? undefined : 'No rules set.');
}

export { applyPlaceholders };
