// /start, /help, /about, /id, /ping and the welcome menu callbacks (m:home, m:help, m:help:<cat>, m:about).

import { getBotSetting } from '../../database/settings.js';
import { backCloseRow, btn, closeBtn, gridRows, markup, pagerRow, rowsToReplyMarkup, urlBtn } from '../../keyboards/inlineKeyboard.js';
import { blockquote, box, cmdHtml, formatCommandHelp, formatMenu, formatWelcome, section } from '../../ui/design.js';
import { heading } from '../../ui/typography.js';
import { esc, field, groupWelcomeMessage, messages } from '../../utils/formatter.js';
import { reactOk, reply, visibleLength } from '../../handlers/helpers.js';
import { isAutoPfp, botPfpFileId } from './welcomeSettings.js';
import { safeJsonParse } from '../../utils/helpers.js';
import { isHttpUrl } from '../../utils/validation.js';
import { getMemberStatus, visibleAccessLevels, isBotOwner } from '../../core/permissions.js';
import { isMessageNotModified } from '../../services/telegram.js';
import { developerLink } from '../../core/config.js';
import { getRole, isModeratorRole, ROLE } from '../../core/roles.js';
import { scheduleDelete } from '../../database/groupMod.js';
import { countSudoUsers } from '../../database/roles.js';
import { logger } from '../../utils/logger.js';
import { boxHtml } from '../../ui/design.js';
import { clonebotCommand, cloneWebhookStart } from '../clones/clonebot.js';

// ---------- welcome ----------

export async function addToGroupUrl(ctx) {
  if (ctx.config.links.addToGroup && isHttpUrl(ctx.config.links.addToGroup)) return ctx.config.links.addToGroup;
  const info = await ctx.botInfo().catch(() => null);
  return info?.username ? `https://t.me/${info.username}?startgroup=true&admin=delete_messages+pin_messages+invite_users` : '';
}

/** The Developer button. With DEVELOPER_ID it is a callback button: its tap posts a profile link (tg://user) because a
 *  callback cannot open a profile by itself. With only DEVELOPER_URL it stays a normal link. */
function developerButton(ctx, dev) {
  // DEVELOPER_ID (secret) -> a URL button that opens the developer's profile: tg://user?id=<id>
  if (ctx.config.developerId && ctx.config.developerId > 0) return urlBtn('👨‍💻 Developer', `tg://user?id=${ctx.config.developerId}`, { style: 'primary' });
  if (dev) return urlBtn('👨‍💻 Developer', dev, { style: 'primary' });
  return null;
}

/** Developer button tap. Tries to open the developer's profile directly as a pop-up (answerCallbackQuery url).
 *  If Telegram refuses the tg:// link for a callback, the pop-up shows the developer's ID instead. */
export async function developerCallback(ctx, cq) {
  const id = ctx.config.developerId;
  if (!id) {
    const link = ctx.config.links.developer;
    return ctx.tg.answerCallbackQuery(cq.id, link ? `Developer: ${link}`.slice(0, 190) : 'Developer is not configured.', true);
  }
  try {
    await ctx.tg.answerCallbackQuery(cq.id, undefined, false, { url: `tg://user?id=${Number(id)}` });
  } catch (e) {
    logger.warn('developer profile link refused by Telegram', { error: e?.message });
    await ctx.tg.answerCallbackQuery(cq.id, `Developer ID: ${id}. Search this ID or open the profile from Telegram.`, true);
  }
  return undefined;
}

export async function welcomeKeyboard(ctx, role = ROLE.USER) {
  const dev = developerLink(ctx.config);
  const rows = [
    [btn('⚙️ Commands', 'm:help'), btn('❔ Help', 'm:guide', { style: 'primary' })],
    [btn('✨ About', 'm:about', { style: 'primary' }), ...(developerButton(ctx, dev) ? [developerButton(ctx, dev)] : [])],
    [urlBtn('📢 Updates', ctx.config.links.updates, { style: 'primary' })],
    [urlBtn('➕ Add To Group', await addToGroupUrl(ctx), { style: 'success' })],
  ];
  if (isModeratorRole(role)) rows.splice(2, 0, [btn('🛡 Panel', 'pn:m', { style: 'primary' })]);
  const custom = safeJsonParse(await getBotSetting(ctx.db, 'welcome_buttons', ''), null);
  const base = markup(rows).inline_keyboard; // drops buttons whose URL is not configured
  if (role === ROLE.USER && Array.isArray(custom) && custom.length) base.push(...(await rowsToReplyMarkup(ctx.db, custom)).inline_keyboard);
  return { inline_keyboard: base };
}

async function welcomeStats(ctx) {
  try {
    const [u, g, s] = await Promise.all([ctx.db.value('SELECT COUNT(*) FROM users'), ctx.db.value('SELECT COUNT(*) FROM groups WHERE is_active = 1'), countSudoUsers(ctx.db)]);
    // Sudo is only shown to the Main Owner (see statsLine).
    return { users: Number(u), groups: Number(g), sudo: Number(s) };
  } catch { return null; }
}

/**
 * Private /start, every time (about 2 seconds):
 *  1. the bot sends a text emoji with a message effect (Telegram plays it on arrival, no tap needed);
 *  2. the user's /start gets a few reactions while the emoji shows;
 *  3. the same message is edited into the welcome: text, or the welcome picture / GIF / video (editMessageMedia).
 */
export const INTRO_EFFECTS = [
  { emoji: '🎉', effect_id: '5046509860389126442' },
  { emoji: '🔥', effect_id: '5104841245755180586' },
  { emoji: '❤️', effect_id: '5044134455711629726' },
  { emoji: '👍', effect_id: '5107584321108051014' },
  { emoji: '💩', effect_id: '5046589136895476101' },
];
const INTRO_REACTIONS = ['🎉', '🔥', '❤', '🤩'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendIntroWelcome(ctx, msg) {
  const chatId = msg.chat.id;
  const { caption, media, keyboard } = await welcomeContent(ctx, msg.from);
  const intro = INTRO_EFFECTS[Math.floor(Math.random() * INTRO_EFFECTS.length)];

  // 1. a plain text emoji with a message effect (Telegram plays it on arrival).
  let teaser = null;
  try { teaser = await ctx.tg.sendMessage(chatId, intro.emoji, { message_effect_id: intro.effect_id }); } catch (e) {
    if (/effect/i.test(String(e?.message))) { try { teaser = await ctx.tg.sendMessage(chatId, intro.emoji, {}); } catch { teaser = null; } }
  }
  if (!teaser?.message_id) return sendWelcome(ctx, chatId, { user: msg.from });

  // 2. a few reactions (or a plain pause) while the emoji shows.
  if (ctx.config.reactions) {
    for (const emoji of INTRO_REACTIONS) {
      try { await ctx.tg.react(chatId, msg.message_id, emoji); } catch { break; }
      await sleep(500);
    }
  } else {
    await sleep(2000);
  }

  // 3. the emoji text message becomes the welcome, in the same message:
  //    - text welcome: editMessageText;
  //    - picture / GIF / video welcome: editMessageMedia converts the text message into that media.
  //    If Telegram refuses the edit, the emoji is deleted and the welcome is sent as a new message (no effect, so it does not replay).
  try {
    if (!media) await ctx.tg.editMessageText(chatId, teaser.message_id, caption, { reply_markup: keyboard });
    else await ctx.tg.editMessageMedia(chatId, teaser.message_id, { type: media.type || 'photo', media: media.file, caption, parse_mode: 'HTML' }, { reply_markup: keyboard });
    return true;
  } catch (e) {
    logger.warn('intro edit failed, sending the welcome fresh', { error: e?.message });
  }
  await ctx.tg.deleteMessage(chatId, teaser.message_id).catch(() => {});
  await sendWelcome(ctx, chatId, { user: msg.from, effect: false });
  return true;
}


/** Resolves caption + image + keyboard for the welcome screen from stored settings (falling back to config). */
/** The picture every welcome uses: the bot's own profile picture when Auto PFP is on, else the saved one. */
export async function currentWelcomeImage(ctx) {
  return (await currentWelcomeMedia(ctx)).file;
}

/** { file, type } — the welcome picture: a photo, a video or a GIF (animation). */
export async function currentWelcomeMedia(ctx) {
  if (await isAutoPfp(ctx)) {
    const pfp = await botPfpFileId(ctx);
    if (pfp) return { file: pfp, type: 'photo' };
  }
  const file = (await getBotSetting(ctx.db, 'welcome_image', '')) || ctx.config.welcomeImage || '';
  const type = (await getBotSetting(ctx.db, 'welcome_image_type', '')) || 'photo';
  return { file, type };
}

/** Sends the welcome picture with a caption; a photo, a video or a GIF. Returns the sent message. */
export function sendWelcomeMedia(ctx, chatId, media, opts = {}) {
  return ctx.tg.sendMedia(chatId, media.type || 'photo', media.file, opts);
}

export async function welcomeContent(ctx, user = null) {
  const [caption, media] = await Promise.all([getBotSetting(ctx.db, 'welcome_caption', ''), currentWelcomeMedia(ctx)]);
  const role = user?.id ? await getRole(ctx, user.id) : ROLE.USER;
  return {
    role,
    // An owner-customised caption (/setwelcome) is what normal users see; owner and moderators always get their role greeting.
    caption: caption && role === ROLE.USER ? caption : formatWelcome({ botName: ctx.config.botName, firstName: user?.first_name, version: ctx.config.version, role, stats: await welcomeStats(ctx) }),
    media: media.file ? media : null,
    keyboard: await welcomeKeyboard(ctx, role),
  };
}

/** 🎉 message effect (private chats only). If Telegram rejects the effect the message is sent again without it. */
/** Message effects for /start (same pool as the reference design): 🔥, 🎉 and a third effect, picked at random. */
export const START_EFFECT_IDS = ['5104841245755180586', '5046509860389126442', '5107584321108051014'];
export const pickStartEffect = () => START_EFFECT_IDS[Math.floor(Math.random() * START_EFFECT_IDS.length)];
async function withEffect(ctx, chatId, send) {
  if (!ctx.config.welcomeEffect || !(Number(chatId) > 0)) return send({});
  try { return await send({ message_effect_id: pickStartEffect() }); } catch (e) {
    if (/effect/i.test(String(e?.message))) return send({});
    throw e;
  }
}

export async function sendWelcome(ctx, chatId, { replyTo, user = null, effect = true } = {}) {
  const { caption, media, keyboard } = await welcomeContent(ctx, user);
  const reply_parameters = replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {};
  const withFx = (send) => (effect ? withEffect(ctx, chatId, send) : send({}));
  if (media) {
    try {
      return await withFx((fx) => sendWelcomeMedia(ctx, chatId, media, { caption, reply_markup: keyboard, ...reply_parameters, ...fx }));
    } catch (e) {
      logger.warn('welcome image failed, falling back to text', { error: e?.message });
    }
  }
  return withFx((fx) => ctx.tg.sendMessage(chatId, caption, { reply_markup: keyboard, ...fx }));
}

/** The group /help card: picture + reaction + a button that opens the private help (which lists group commands too). */
/** /start in a group: the same welcome picture and text as in private, with only a "Start in DM" button. */
async function groupStartCard(ctx, msg) {
  const { caption, media } = await welcomeContent(ctx, msg.from);
  const info = await ctx.botInfo().catch(() => null);
  const dm = info?.username ? `https://t.me/${info.username}?start=start` : '';
  const keyboard = markup([[dm ? urlBtn('📩 Start in DM', dm, { style: 'primary' }) : btn('⚙️ Commands', 'm:help')]]);
  const extra = { reply_markup: keyboard, reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } };
  let sent = null;
  if (media) {
    try { sent = await sendWelcomeMedia(ctx, msg.chat.id, media, { caption, ...extra }); } catch { sent = null; }
  }
  if (!sent) sent = await ctx.tg.sendMessage(msg.chat.id, caption, extra);
  await reactOk(ctx, msg, null, { anyChat: true }).catch(() => {});
  // Like the group help card, it tidies itself up after 5 minutes (handled by the 1-minute cron).
  if (sent?.message_id) await scheduleDelete(ctx.db, msg.chat.id, sent.message_id, 300).catch(() => {});
  return sent;
}

async function groupHelpCard(ctx, msg) {
  const info = await ctx.botInfo().catch(() => null);
  const dm = info?.username ? `https://t.me/${info.username}?start=help` : '';
  // Two quotes: the heading on top, the explanation below (no frame lines).
  const text = `${blockquote(`📚 ${heading(`${ctx.config.botName} Help`)}`)}\n${blockquote('All commands — including the group ones — are in my private help. Tap the button to open it.')}`;
  const keyboard = markup([dm ? [urlBtn('📩 DM / Help', dm, { style: 'primary' })] : [btn('⚙️ COMMANDS', 'm:help')], [closeBtn()]]);
  const media = await currentWelcomeMedia(ctx);
  const extra = { reply_markup: keyboard, reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } };
  let sent = null;
  if (media.file) {
    try { sent = await sendWelcomeMedia(ctx, msg.chat.id, media, { caption: text, ...extra }); } catch { sent = null; }
  }
  if (!sent) sent = await ctx.tg.sendMessage(msg.chat.id, text, extra);
  await reactOk(ctx, msg, null, { anyChat: true }).catch(() => {});
  // Group help panels tidy themselves up after 5 minutes (handled by the 1-minute cron).
  if (sent?.message_id) await scheduleDelete(ctx.db, msg.chat.id, sent.message_id, 300).catch(() => {});
  return sent;
}

export async function startCommand(ctx, msg, args = '') {
  const deep = String(args || '').trim();
  if (msg.chat.type === 'private' && /^clonewh_\d+$/.test(deep)) return cloneWebhookStart(ctx, msg, deep.slice('clonewh_'.length));
  if (msg.chat.type === 'private' && deep === 'clonebot' && !ctx.clone) return clonebotCommand(ctx, msg);
  if (msg.chat.type === 'private' && /^help$/i.test(String(args || '').trim())) return helpCommand(ctx, msg, '');
  if (msg.chat.type !== 'private') return groupStartCard(ctx, msg);
  return sendIntroWelcome(ctx, msg);
}

export async function sendGroupWelcome(ctx, chat) {
  return ctx.tg.sendMessage(chat.id, groupWelcomeMessage(ctx.config.botName, chat.title), { reply_markup: markup([[btn('⚙️ Commands', 'm:help')]]) });
}

// ---------- help ----------

export const CATEGORIES = [
  { id: 'anime', label: '🎌 Anime', title: 'Anime Information & Schedule', blurb: 'Anime details and airing times (IST).' },
  { id: 'translate', label: '🌐 Translation', title: 'Translation', blurb: 'Translate text between languages.' },
  { id: 'image', label: '🖼️ Image Search', title: 'Image Search', blurb: 'Search for pictures with attribution.' },
  { id: 'buttons', label: '🧩 Buttons', title: 'Inline Button Builder', blurb: 'Custom buttons with colours. Link buttons stay on forwarded copies; pop-up buttons work on the bot\'s own message.' },
  { id: 'broadcast', label: '📡 Broadcast', title: 'Broadcast', blurb: 'Send announcements to users and groups.' },
  { id: 'backup', label: '💾 Backup', title: 'Backup & Restore', blurb: 'Export and restore bot or group data.' },
  { id: 'groups', label: '👑 Ownership', title: 'Group Ownership & Access', blurb: 'Group owner registration and authorised admins.' },
  { id: 'dashboard', label: '📊 Owner Panel', title: 'Owner Panel & Welcome Settings', blurb: 'Statistics and welcome customisation.' },
  { id: 'mod', label: '🛡 Moderator Tools', title: 'Moderator Tools', blurb: 'Dashboard and global bans — for bot moderators only.' },
  { id: 'ownerRoles', label: '👑 Sudo Access', title: 'Sudo Management', blurb: 'Add or remove sudo moderators — main owner only.' },
  { id: 'general', label: '🛠️ Basics', title: 'Basic Commands', blurb: 'Everyday commands.' },
  // ---- group management (shown inside groups; admins see the admin commands) ----
  { id: 'gm_mod', label: '🔨 Moderation', title: 'Moderation', blurb: 'Ban, mute and kick — reply to a user or give an ID.' },
  { id: 'gm_warn', label: '⚠️ Warnings', title: 'Warning System', blurb: 'Warn members; the limit triggers an action.' },
  { id: 'gm_admin', label: '👮 Admin Tools', title: 'Admin Management', blurb: 'Promote, demote and list admins.' },
  { id: 'gm_msg', label: '📌 Messages', title: 'Message Management', blurb: 'Delete, purge and pin messages.' },
  { id: 'gm_locks', label: '🔒 Locks', title: 'Locks', blurb: 'Block message types in this group.' },
  { id: 'gm_flood', label: '🚨 Antiflood', title: 'Antiflood', blurb: 'Stop members from flooding the chat.' },
  { id: 'gm_spam', label: '🛑 Anti-Spam', title: 'Anti-Spam & Anti-Raid', blurb: 'Repeat/link spam rules and join-raid protection.' },
  { id: 'gm_verify', label: '🔐 Verification', title: 'Verification (Captcha)', blurb: 'Make new members prove they are human.' },
  { id: 'gm_filters', label: '🎨 Filters', title: 'Filters', blurb: 'Auto-reply when a keyword appears.' },
  { id: 'gm_notes', label: '📝 Notes', title: 'Notes', blurb: 'Save text and media to fetch later.' },
  { id: 'gm_welcome', label: '👋 Greetings', title: 'Welcome & Goodbye', blurb: 'Messages for members joining or leaving.' },
  { id: 'gm_rules', label: '📜 Rules', title: 'Rules', blurb: 'Group rules members can read.' },
  { id: 'gm_bl', label: '🚫 Blacklist', title: 'Blacklist', blurb: 'Auto-handle banned words.' },
  { id: 'gm_reports', label: '📢 Reports', title: 'Reports', blurb: 'Members can report messages to admins.' },
  { id: 'gm_settings', label: '⚙️ Settings', title: 'Group Settings & Cleanup', blurb: 'Settings panel and cleanup options.' },
  { id: 'gm_info', label: '👥 Information', title: 'User & Group Information', blurb: 'IDs, user and group details, invite link.' },
  { id: 'gm_log', label: '📋 Mod History', title: 'Moderation History', blurb: 'Review what moderators did.' },
];

/** Main-menu sections: which categories live under which button. A section/category is shown only if the
 *  person may use at least one command in it. */
export const SECTIONS = [
  { id: 'gm', label: '⚙️ Group Management', title: 'Group Management', cats: ['gm_mod', 'gm_warn', 'gm_admin', 'gm_msg', 'gm_info', 'gm_log', 'gm_settings', 'groups'] },
  { id: 'sec', label: '🛡️ Security', title: 'Security Tools', cats: ['gm_locks', 'gm_flood', 'gm_spam', 'gm_verify', 'gm_bl', 'gm_reports'] },
  { id: 'auto', label: '🎨 Filters & Automation', title: 'Filters & Automation', cats: ['gm_filters', 'gm_notes', 'gm_welcome', 'gm_rules', 'buttons'] },
  { id: 'tools', label: '🎌 Anime & Tools', title: 'Anime & Tools', cats: ['anime', 'translate', 'image', 'general'] },
  { id: 'data', label: '📦 Backup & Database', title: 'Backup & Database', cats: ['backup'] },
  { id: 'mod', label: '🛡 Moderator', title: 'Moderator Tools', cats: ['mod'] },
  { id: 'owner', label: '👑 Owner', title: 'Owner Commands', cats: ['broadcast', 'dashboard', 'ownerRoles'] },
];

const sectionOf = (categoryId) => SECTIONS.find((s) => s.cats.includes(categoryId));
const PAGE_SIZE = 8;

const ACCESS_TEXT = {
  public: 'Everyone',
  groupAdmin: 'Group administrators',
  groupManage: 'Group owner and authorised admins',
  owner: 'Main owner only',
  sudo: 'Bot moderators (owner and sudo users)',
  backup: 'Bot owner (full backup) · group owner (group backup)',
};

/** Commands visible to a person (by access level) grouped by category. `registry` is the command table. */
export function visibleCommands(registry, levels, { inGroup = true } = {}) {
  const out = {};
  for (const c of registry) {
    if (!levels.has(inGroup && c.groupAccess ? c.groupAccess : c.access)) continue;
    (out[c.category] ||= []).push(c);
  }
  return out;
}

async function helpContext(ctx, chat, from) {
  const { COMMANDS } = await import('../../handlers/commands.js');
  const levels = await visibleAccessLevels(ctx, { chat, from });
  // In a private chat the group commands are listed too (for group admins/owners as a reference). Running them
  // still requires the real rights inside the group, which every command checks when used.
  if (chat?.type === 'private') ['groupAdmin', 'groupManage'].forEach((l) => levels.add(l));
  return { visible: visibleCommands(COMMANDS, levels, { inGroup: chat?.type !== 'private' }), levels };
}

const catVisible = (visible, c) => visible[c.id]?.length;

/** MAIN MENU — sections grid. */
export async function helpMainScreen(ctx, chat, from) {
  const { visible } = await helpContext(ctx, chat, from);
  const inGroup = chat?.type !== 'private';
  const sections = SECTIONS.filter((s) => s.cats.some((id) => catVisible(visible, CATEGORIES.find((c) => c.id === id), inGroup)));
  const rows = gridRows(sections.map((s) => btn(s.label, `m:hs:${s.id}`, { style: 'none' })));
  rows.push([btn('✨ About', 'm:about', { style: 'primary' }), btn('🏠 Home', 'm:home', { style: 'none' })]);
  rows.push([closeBtn()]);
  return {
    text: `${formatMenu('📚', `${ctx.config.botName} Main Menu`, 'Pick a section to explore every command you can use.', 'Only commands you are allowed to use are shown.')}\n\n${section('🔎', 'Tip')}\nSend <code>/help ban</code> to see help for a single command.`,
    keyboard: markup(rows),
  };
}

/** A section: two-column grid of its categories. */
export async function helpSectionScreen(ctx, chat, from, sectionId) {
  const sec = SECTIONS.find((s) => s.id === sectionId);
  if (!sec) return null;
  const { visible } = await helpContext(ctx, chat, from);
  const inGroup = chat?.type !== 'private';
  const cats = sec.cats.map((id) => CATEGORIES.find((c) => c.id === id)).filter((c) => c && catVisible(visible, c, inGroup));
  if (!cats.length) return null;
  const rows = gridRows(cats.map((c) => btn(c.label, `m:help:${c.id}`, { style: 'none' })));
  rows.push(backCloseRow('m:help'));
  return { text: formatMenu(sec.label.split(' ')[0], sec.title, 'Choose a category to see its commands.'), keyboard: markup(rows) };
}

/** A category: paginated command list. */
export async function helpCategoryScreen(ctx, chat, from, categoryId, page = 0) {
  const category = CATEGORIES.find((c) => c.id === categoryId);
  const { visible } = await helpContext(ctx, chat, from);
  const cmds = visible[categoryId];
  if (!category || !cmds?.length) return null;
  const pages = Math.ceil(cmds.length / PAGE_SIZE);
  const p = Math.min(Math.max(Number(page) || 0, 0), pages - 1);
  const slice = cmds.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
  const badge = (c) => (c.access === 'owner' ? ' 👑' : c.access === 'sudo' ? ' 🛡' : c.access === 'groupAdmin' || c.access === 'groupManage' ? ' 🔒' : '') + (c.groupOnly ? ' 👥' : '');
  const body = blockquote(slice.map((c) => `${cmdHtml([].concat(c.usage)[0])}${badge(c)}\n${esc(c.description)}`).join('\n\n'));
  const emoji = category.label.split(' ')[0];
  const sec = sectionOf(categoryId);
  const rows = [];
  const pager = pagerRow(p, pages, (n) => `m:help:${categoryId}:${n}`);
  if (pager.length) rows.push(pager);
  rows.push(backCloseRow(sec ? `m:hs:${sec.id}` : 'm:help'));
  return {
    text: `${box(emoji, category.title)}\n\n${esc(category.blurb)}\n\n${section('📖', 'Commands')}${pages > 1 ? ` (${p + 1}/${pages})` : ''}\n${body}\n\n💡 <i>/help &lt;command&gt; for details · 🔒 admin · 👥 group only · 🛡 moderator · 👑 owner</i>`,
    keyboard: markup(rows),
  };
}

/** /help <command>: one professionally formatted card built only from the real command table. */
export async function helpCommandScreen(ctx, name) {
  const { findCommand } = await import('../../handlers/commands.js');
  const cmd = findCommand(String(name).replace(/^\//, '').toLowerCase());
  if (!cmd) return null;
  const cat = CATEGORIES.find((c) => c.id === cmd.category);
  const access = cmd.groupAccess ? `${ACCESS_TEXT[cmd.groupAccess]} (in groups)` : ACCESS_TEXT[cmd.access] || '';
  const sec = sectionOf(cmd.category);
  return {
    text: formatCommandHelp({ ...cmd, emoji: cat?.label.split(' ')[0] }, { access }),
    keyboard: markup([[btn('📚 Menu', 'm:help', { style: 'primary' }), closeBtn()], ...(sec ? [] : [])]),
  };
}

/** /help — main menu, or `/help <command>`. */
export async function helpCommand(ctx, msg, args = '') {
  const wanted = String(args || '').trim().split(/\s+/)[0];
  if (wanted) {
    const card = await helpCommandScreen(ctx, wanted);
    if (card) return reply(ctx, msg, card.text, { reply_markup: card.keyboard });
    return reply(ctx, msg, messages.warning('Command Not Found', `There is no command named /${wanted.replace(/^\//, '')}. Open the menu to browse every command.`), { reply_markup: markup([[btn('⚙️ Commands', 'm:help')]]) });
  }
  if (msg.chat.type !== 'private') return groupHelpCard(ctx, msg);
  const screen = await helpMainScreen(ctx, msg.chat, msg.from);
  return reply(ctx, msg, screen.text, { reply_markup: screen.keyboard });
}

/** ❔ Help — a short "how to use this bot" guide (static, factual). */
export function guideScreen(ctx) {
  const text = [
    box('❔', 'How To Use'),
    `${section('🎯', 'Targeting a member')}\nReply to their message, or give a numeric user ID (an @username works only for people I already know).`,
    `${section('⏱', 'Durations')}\n<code>30s</code> <code>10m</code> <code>2h</code> <code>1d</code> <code>1w</code> — the reason comes after the duration.`,
    `${section('🧩', 'Custom buttons')}\n<code>(Label - https://example.com)</code> — one row per line, <code>|</code> for the same row.`,
    `${section('🔐', 'Permissions')}\nGroup commands need admin rights, and I need the matching Telegram admin right in the group.`,
  ].join('\n\n');
  return { text, keyboard: markup([[btn('⚙️ Commands', 'm:help'), btn('🏠 Home', 'm:home', { style: 'primary' })], [closeBtn()]]) };
}

// ---------- about ----------

export function aboutScreen(ctx, info) {
  const c = ctx.config;
  const rows = [
    field('🤖', 'Bot', `${c.botName}${info?.username ? ` (@${info.username})` : ''}`),
    field('🔖', 'Version', c.version),
    field('🗄', 'Database', 'Turso (libSQL)'),
    field('☁️', 'Platform', 'Cloudflare Workers (webhook)'),
    field('⚡', 'Cache', ctx.cache.backend === 'kv' ? 'Cloudflare KV' : 'Database'),
  ];
  const features = [
    '🛡️ Group management & moderation',
    '🎌 Anime information & airing schedule',
    '🌐 Translation between languages',
    '🖼️ Image search',
    '📡 Broadcasts & group announcements',
    '💾 Automatic & manual backups, import/restore',
  ].join('\n');
  const links = [c.links.developer && isHttpUrl(c.links.developer) ? `👨‍💻 <a href="${esc(c.links.developer)}">Developer</a>` : null, c.links.updates && isHttpUrl(c.links.updates) ? `📢 <a href="${esc(c.links.updates)}">Updates</a>` : null].filter(Boolean).join('  •  ');
  return {
    text: `${box('✨', `About ${c.botName}`)}\n\n${rows.join('\n')}\n\n${section('🌟', 'Features')}\n${features}${links ? `\n\n${links}` : ''}`,
    keyboard: markup([backCloseRow('m:home')]),
  };
}

export async function aboutCommand(ctx, msg) {
  const screen = aboutScreen(ctx, await ctx.botInfo().catch(() => null));
  return reply(ctx, msg, screen.text, { reply_markup: screen.keyboard });
}

export async function idCommand(ctx, msg) {
  const target = msg.reply_to_message?.from || msg.from;
  const lines = ['🆔 <b>Your IDs</b>', '', field('👤', msg.reply_to_message ? 'User ID (replied user)' : 'User ID', `<code>${target.id}</code>`, { raw: true })];
  if (msg.chat.type !== 'private') lines.push(field('👥', 'Chat ID', `<code>${msg.chat.id}</code>`, { raw: true }));
  return reply(ctx, msg, lines.join('\n'));
}

export async function pingCommand(ctx, msg) {
  const t = Date.now();
  const sent = await reply(ctx, msg, '🏓 <b>Pong!</b>');
  const ms = Date.now() - t;
  return ctx.tg.editMessageText(msg.chat.id, sent.message_id, `${boxHtml("🏓", "Pong!")}\n\n⚡ Telegram round-trip: ${ms} ms`).catch(() => {});
}

// ---------- callbacks ----------

const CAPTION_LIMIT = 1000;

/**
 * Moves the user to another screen by EDITING the current message wherever Telegram allows it:
 *  - text message  -> editMessageText
 *  - photo message -> editMessageCaption when the new text fits a caption (the picture stays)
 *  - otherwise     -> send the new screen and remove the old one
 */
async function showScreen(ctx, cq, screen) {
  const m = cq.message;
  // Any picture-type message (photo, video, GIF, file) has a caption, not text, so it must be edited as a caption.
  const isPhoto = Boolean((Array.isArray(m.photo) && m.photo.length) || m.video || m.animation || m.document);
  try {
    if (screen.welcome) {
      const { caption, media, keyboard } = await welcomeContent(ctx, cq.from);
      if (isPhoto && media) { await ctx.tg.editMessageCaption(m.chat.id, m.message_id, caption, { reply_markup: keyboard }); return; }
      if (!isPhoto && !media) { await ctx.tg.editMessageText(m.chat.id, m.message_id, caption, { reply_markup: keyboard }); return; }
      await sendWelcome(ctx, m.chat.id, { user: cq.from });
      await ctx.tg.deleteMessage(m.chat.id, m.message_id).catch(() => {});
      return;
    }
    if (isPhoto && visibleLength(screen.text) <= CAPTION_LIMIT) {
      await ctx.tg.editMessageCaption(m.chat.id, m.message_id, screen.text, { reply_markup: screen.keyboard });
    } else if (isPhoto) {
      await ctx.tg.sendMessage(m.chat.id, screen.text, { reply_markup: screen.keyboard });
      await ctx.tg.deleteMessage(m.chat.id, m.message_id).catch(() => {});
    } else {
      await ctx.tg.editMessageText(m.chat.id, m.message_id, screen.text, { reply_markup: screen.keyboard });
    }
  } catch (e) {
    if (isMessageNotModified(e)) return;
    // The message may have been deleted or be too old to edit: send a fresh copy instead of failing silently.
    if (/message to edit not found|can't be edited|MESSAGE_ID_INVALID|no text in the message|no caption in the message/i.test(String(e?.message))) {
      if (screen.welcome) {
        // The welcome screen could not be edited in place: send it fresh and remove the old message.
        await sendWelcome(ctx, m.chat.id, { user: cq.from });
        await ctx.tg.deleteMessage(m.chat.id, m.message_id).catch(() => {});
        return;
      }
      await ctx.tg.sendMessage(m.chat.id, screen.text || '', { reply_markup: screen.keyboard });
      return;
    }
    throw e;
  }
}

/** Callbacks: m:home | m:help[:<category>[:<page>]] | m:hs:<section> | m:guide | m:about */
export async function menuCallback(ctx, cq, parts) {
  const action = parts[1];
  const chat = cq.message.chat;
  if (action === 'home') {
    await ctx.tg.answerCallbackQuery(cq.id);
    return showScreen(ctx, cq, { welcome: true });
  }
  if (action === 'about') {
    await ctx.tg.answerCallbackQuery(cq.id);
    return showScreen(ctx, cq, aboutScreen(ctx, await ctx.botInfo().catch(() => null)));
  }
  if (action === 'guide') {
    await ctx.tg.answerCallbackQuery(cq.id);
    return showScreen(ctx, cq, guideScreen(ctx));
  }
  if (action === 'hs') {
    const screen = await helpSectionScreen(ctx, chat, cq.from, parts[2]);
    if (!screen) return ctx.tg.answerCallbackQuery(cq.id, '🔒 You do not have access to those commands.', true);
    await ctx.tg.answerCallbackQuery(cq.id);
    return showScreen(ctx, cq, screen);
  }
  if (action === 'help') {
    const screen = parts[2] ? await helpCategoryScreen(ctx, chat, cq.from, parts[2], parts[3]) : await helpMainScreen(ctx, chat, cq.from);
    if (!screen) return ctx.tg.answerCallbackQuery(cq.id, '🔒 You do not have access to those commands.', true);
    await ctx.tg.answerCallbackQuery(cq.id);
    return showScreen(ctx, cq, screen);
  }
  return ctx.tg.answerCallbackQuery(cq.id, 'Unknown button.');
}

/** x:close — removes a bot menu. In groups only the person who opened it (the replied-to command) or an admin may. x:noop — inert label button. */
export async function utilityCallback(ctx, cq, parts) {
  if (parts[1] === 'noop') return ctx.tg.answerCallbackQuery(cq.id);
  const m = cq.message;
  if (parts[1] !== 'close') return ctx.tg.answerCallbackQuery(cq.id, 'Unknown button.');
  if (m.chat.type !== 'private') {
    const opener = m.reply_to_message?.from?.id;
    if (opener !== cq.from.id) {
      const member = await getMemberStatus(ctx, m.chat.id, cq.from.id).catch(() => null);
      if (!['creator', 'administrator'].includes(member?.status) && !isBotOwner(ctx.config, cq.from.id)) {
        return ctx.tg.answerCallbackQuery(cq.id, '🔒 Only the person who opened this menu or an admin can close it.', true);
      }
    }
  }
  try {
    await ctx.tg.deleteMessage(m.chat.id, m.message_id);
  } catch {
    // Too old to delete: leave the text but remove the buttons so the menu is closed for everyone.
    await ctx.tg.editMessageReplyMarkup?.(m.chat.id, m.message_id, { inline_keyboard: [] }).catch(() => {});
  }
  return ctx.tg.answerCallbackQuery(cq.id);
}

export { isBotOwner };
