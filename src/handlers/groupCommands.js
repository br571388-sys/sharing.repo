// Group-management command table (merged into COMMANDS in commands.js). One entry per command; aliases share a handler.
// Moderation actions are `groupAdmin` here; the handlers then verify the SPECIFIC Telegram right (ban, delete, pin…).

import * as mod from '../features/groupmgmt/moderation.js';
import * as warn from '../features/groupmgmt/warnings.js';
import * as msgTools from '../features/groupmgmt/messageTools.js';
import * as admins from '../features/groupmgmt/admins.js';
import * as locks from '../features/groupmgmt/locks.js';
import * as prot from '../features/groupmgmt/protection.js';
import * as captcha from '../features/groupmgmt/captcha.js';
import * as filters from '../features/groupmgmt/filters.js';
import * as greet from '../features/groupmgmt/greetings.js';
import * as rules from '../features/groupmgmt/rules.js';
import * as reports from '../features/groupmgmt/reports.js';
import * as info from '../features/groupmgmt/info.js';
import * as menu from '../features/groupmgmt/settingsMenu.js';
import * as clean from '../features/groupmgmt/cleanup.js';
import * as afk from '../features/groupmgmt/afkApprove.js';

const A = 'groupAdmin';
const P = 'public';
const g = (names, category, usage, description, access, run, extra = {}) => ({ names, category, usage, description, access, run, groupOnly: true, ...extra });

export const GROUP_COMMANDS = [
  // ---- 🛡️ moderation ----
  g(['ban'], 'gm_mod', '/ban [user id] [reason]', 'Ban a user (reply or user id).', A, mod.banCommand),
  g(['unban'], 'gm_mod', '/unban [user id]', 'Lift a ban.', A, mod.unbanCommand),
  g(['kick'], 'gm_mod', '/kick [user id] [reason]', 'Remove a user; they can rejoin.', A, mod.kickCommand),
  g(['mute'], 'gm_mod', '/mute [user id] [reason]', 'Stop a user from sending messages.', A, mod.muteCommand),
  g(['unmute'], 'gm_mod', '/unmute [user id]', 'Restore a user\'s permissions.', A, mod.unmuteCommand),
  g(['tban'], 'gm_mod', '/tban [user id] <duration> [reason]', 'Temporary ban (30s – 366d).', A, mod.tbanCommand),
  g(['tmute'], 'gm_mod', '/tmute [user id] <duration> [reason]', 'Temporary mute (30s – 366d).', A, mod.tmuteCommand),
  g(['sban'], 'gm_mod', '/sban [user id] [reason]', 'Silent ban: deletes your command, no notice.', A, mod.sbanCommand),
  g(['skick'], 'gm_mod', '/skick [user id] [reason]', 'Silent kick.', A, mod.skickCommand),
  g(['smute'], 'gm_mod', '/smute [user id] [reason]', 'Silent mute.', A, mod.smuteCommand),
  g(['dkick'], 'gm_mod', '/dkick (reply)', 'Delete the replied message + your command, then kick.', A, mod.dkickCommand),
  g(['kickme'], 'gm_mod', '/kickme', 'Remove yourself from the group.', P, mod.kickmeCommand),
  g(['banme'], 'gm_mod', '/banme', 'Ban yourself (only if /selfmod is on).', P, mod.banmeCommand),
  g(['muteme'], 'gm_mod', '/muteme [duration]', 'Mute yourself (only if /selfmod is on).', P, mod.mutemeCommand),
  g(['unbanme'], 'gm_mod', '/unbanme', 'Lift a ban you put on yourself.', P, mod.unbanmeCommand, { menu: false }),
  g(['unmuteme'], 'gm_mod', '/unmuteme', 'Lift a mute you put on yourself.', P, mod.unmutemeCommand, { menu: false }),
  g(['selfmod'], 'gm_mod', '/selfmod on|off', 'Allow /banme and /muteme in this group.', A, clean.selfmodCommand, { menu: false }),

  // ---- ⚠️ warnings ----
  g(['warn'], 'gm_warn', '/warn [user id] [reason]', 'Warn a user; the limit triggers /warnmode.', A, warn.warnCommand),
  g(['dwarn'], 'gm_warn', '/dwarn (reply) [reason]', 'Delete the replied message and warn.', A, warn.dwarnCommand),
  g(['swarn'], 'gm_warn', '/swarn [user id] [reason]', 'Silent warning.', A, warn.swarnCommand),
  g(['unwarn'], 'gm_warn', '/unwarn [user id]', 'Remove the latest warning.', A, warn.unwarnCommand),
  g(['rmwarn'], 'gm_warn', '/rmwarn <warning id>', 'Remove one specific warning.', A, warn.rmwarnCommand),
  g(['resetwarn'], 'gm_warn', '/resetwarn [user id]', 'Clear all warnings of a user.', A, warn.resetwarnCommand),
  g(['warns', 'warnings'], 'gm_warn', '/warns [user id]', 'Show warnings (yours, or any member for admins).', P, warn.warnsCommand),
  g(['warnlimit'], 'gm_warn', '/warnlimit <1-100>', 'Warnings before the punishment.', A, warn.warnlimitCommand),
  g(['warnmode'], 'gm_warn', '/warnmode <ban|mute|kick|none> [duration]', 'Punishment at the limit.', A, warn.warnmodeCommand),
  g(['warntime'], 'gm_warn', '/warntime <duration|off>', 'Make new warnings expire.', A, warn.warntimeCommand),

  // ---- 👮 admin management ----
  g(['promote', 'admin'], 'gm_admin', '/promote [user id] [rights] [title]', 'Make a member an admin (rights: basic, all, delete, pin…).', A, admins.promoteCommand),
  g(['demote', 'unadmin'], 'gm_admin', '/demote [user id]', 'Remove admin rights.', A, admins.demoteCommand),
  g(['admins', 'adminlist'], 'gm_admin', '/admins', 'List the group administrators.', P, admins.adminsCommand),
  g(['staff'], 'gm_admin', '/staff', 'Owner, admins and authorised staff.', P, admins.staffCommand),
  g(['sync'], 'gm_admin', '/sync', 'Refresh admins / owner / title from Telegram.', A, admins.syncCommand),

  // ---- 🗑️ message management ----
  g(['del'], 'gm_msg', '/del (reply)', 'Delete the replied message.', A, msgTools.delCommand),
  g(['purge'], 'gm_msg', '/purge (reply)', 'Delete from the replied message to now (max 500).', A, msgTools.purgeCommand),
  g(['spurge'], 'gm_msg', '/spurge (reply)', 'Purge without a confirmation message.', A, msgTools.spurgeCommand),
  g(['purgefrom'], 'gm_msg', '/purgefrom (reply)', 'Mark where a range purge starts.', A, msgTools.purgefromCommand),
  g(['purgeto'], 'gm_msg', '/purgeto (reply)', 'Delete from the /purgefrom mark to this message.', A, msgTools.purgetoCommand),
  g(['pin', 'pinmessage'], 'gm_msg', '/pin [loud] (reply) | /pinmessage <text>', 'Pin the replied message (or post text and pin it).', A, msgTools.pinCommand),
  g(['unpin', 'unpinmessage'], 'gm_msg', '/unpin [all] (reply)', 'Unpin the replied / latest / all messages.', A, msgTools.unpinCommand),

  // ---- 🔒 locks ----
  g(['lock'], 'gm_locks', '/lock <type…>', 'Lock links, media, stickers… (see /locktypes).', A, locks.lockCommand),
  g(['unlock'], 'gm_locks', '/unlock <type…>', 'Unlock types.', A, locks.unlockCommand),
  g(['locks'], 'gm_locks', '/locks', 'Show the current locks.', P, locks.locksCommand),
  g(['locktypes'], 'gm_locks', '/locktypes', 'List every lock type.', P, locks.locktypesCommand),
  g(['lockall'], 'gm_locks', '/lockall', 'Lock every type.', A, locks.lockallCommand),
  g(['unlockall'], 'gm_locks', '/unlockall', 'Remove every lock.', A, locks.unlockallCommand),

  // ---- 🌊 antiflood ----
  g(['antiflood'], 'gm_flood', '/antiflood [on|off]', 'Antiflood status / switch.', A, prot.antifloodCommand),
  g(['setflood'], 'gm_flood', '/setflood <messages> [seconds]', 'Set the flood threshold, e.g. 5 5.', A, prot.setfloodCommand),
  g(['floodlimit'], 'gm_flood', '/floodlimit <n>', 'Only change the message limit.', A, prot.floodlimitCommand, { menu: false }),
  g(['setfloodmode'], 'gm_flood', '/setfloodmode <delete|warn|mute|kick|ban> [duration]', 'Punishment for flooding.', A, prot.setfloodmodeCommand),
  g(['flood'], 'gm_flood', '/flood', 'Show the antiflood settings.', P, prot.floodCommand),
  g(['clearflood'], 'gm_flood', '/clearflood [user id]', 'Reset flood counters.', A, prot.clearfloodCommand, { menu: false }),

  // ---- 🚫 anti-spam / raid ----
  g(['antispam'], 'gm_spam', '/antispam [on|off|mode|repeat|mentions|links|forwards]', 'Spam detection settings.', P, prot.antispamCommand),
  g(['antiraid'], 'gm_spam', '/antiraid [on|off|<joins> <seconds>]', 'Automatic raid detection.', P, prot.antiraidCommand),
  g(['raidmode'], 'gm_spam', '/raidmode on|off', 'Switch raid mode manually.', A, prot.raidmodeCommand),
  g(['raidaction'], 'gm_spam', '/raidaction <kick|ban|mute>', 'What happens to joiners during a raid.', A, prot.raidactionCommand, { menu: false }),
  g(['raidtime'], 'gm_spam', '/raidtime <duration>', 'How long raid mode lasts.', A, prot.raidtimeCommand, { menu: false }),
  g(['clearraid'], 'gm_spam', '/clearraid', 'End raid mode and reset counters.', A, prot.clearraidCommand, { menu: false }),

  // ---- 🔐 verification ----
  g(['captcha'], 'gm_verify', '/captcha [on|off]', 'New-member verification.', P, captcha.captchaCommand),
  g(['verify'], 'gm_verify', '/verify [user id]', 'Admins approve a member; pending members get their button again.', P, captcha.verifyCommand),
  g(['setcaptcha'], 'gm_verify', '/setcaptcha <text>', 'Custom verification text.', A, captcha.setcaptchaCommand, { menu: false }),
  g(['captchamode'], 'gm_verify', '/captchamode <button|math>', 'Challenge type.', A, captcha.captchamodeCommand, { menu: false }),
  g(['captchatime'], 'gm_verify', '/captchatime <duration>', 'Time allowed to verify.', A, captcha.captchatimeCommand, { menu: false }),
  g(['captchakick'], 'gm_verify', '/captchakick <kick|ban|mute>', 'Action when time runs out.', A, captcha.captchakickCommand, { menu: false }),

  // ---- 📝 filters ----
  g(['filter', 'addfilter'], 'gm_filters', '/filter <keyword> <reply>', 'Auto-reply when a keyword is said.', A, filters.filterCommand),
  g(['filters'], 'gm_filters', '/filters', 'List the filters.', P, filters.filtersCommand),
  g(['stop', 'rmfilter', 'removefilter'], 'gm_filters', '/stop <keyword>', 'Remove a filter.', A, filters.stopCommand),
  g(['stopall'], 'gm_filters', '/stopall', 'Remove every filter (asks to confirm).', A, filters.stopallCommand),

  // ---- 📚 notes ----
  g(['save'], 'gm_notes', '/save <name> <text>', 'Save a note (text, media, buttons).', A, filters.saveCommand),
  g(['get'], 'gm_notes', '/get <name>  or  #name', 'Show a note.', P, filters.getCommand),
  g(['notes'], 'gm_notes', '/notes', 'List the notes.', P, filters.notesCommand),
  g(['clear'], 'gm_notes', '/clear <name>', 'Delete a note.', A, filters.clearCommand),
  g(['clearall'], 'gm_notes', '/clearall', 'Delete every note (asks to confirm).', A, filters.clearallCommand),

  // ---- 👋 welcome / goodbye (group) ----
  g(['welcome'], 'gm_welcome', '/welcome [on|off]', 'Show / switch the welcome message.', P, greet.welcomeCommand),
  g(['welcomemute'], 'gm_welcome', '/welcomemute <duration|off>', 'Mute new members for a while.', A, greet.welcomemuteCommand, { menu: false }),
  g(['welcometype'], 'gm_welcome', '/welcometype <auto|text>', 'Use media or text only.', A, greet.welcometypeCommand, { menu: false }),
  g(['cleanwelcome'], 'gm_welcome', '/cleanwelcome <on|off|duration>', 'Auto-delete welcome messages.', A, greet.cleanwelcomeCommand, { menu: false }),
  g(['goodbye'], 'gm_welcome', '/goodbye [on|off]', 'Show / switch the goodbye message.', P, greet.goodbyeCommand),
  g(['setgoodbye'], 'gm_welcome', '/setgoodbye <text>', 'Set the goodbye message.', A, greet.setgoodbyeCommand),
  g(['resetgoodbye'], 'gm_welcome', '/resetgoodbye', 'Restore the default goodbye.', A, greet.resetgoodbyeCommand, { menu: false }),
  g(['cleangoodbye'], 'gm_welcome', '/cleangoodbye <on|off|duration>', 'Auto-delete goodbye messages.', A, greet.cleangoodbyeCommand, { menu: false }),

  // ---- 📜 rules ----
  g(['rules'], 'gm_rules', '/rules', 'Show the group rules.', P, rules.rulesCommand),
  g(['setrules'], 'gm_rules', '/setrules <text>', 'Set the rules.', A, rules.setrulesCommand),
  g(['resetrules', 'clearrules'], 'gm_rules', '/resetrules', 'Remove the rules.', A, rules.clearrulesCommand),

  // ---- 🚫 blacklist ----
  g(['blacklist', 'addblacklist'], 'gm_bl', '/addblacklist <word>[, word]', 'Blacklist words / phrases.', A, rules.blacklistCommand),
  g(['rmblacklist', 'delblacklist'], 'gm_bl', '/rmblacklist <word>', 'Remove blacklisted words.', A, rules.rmblacklistCommand),
  g(['blacklisted'], 'gm_bl', '/blacklisted', 'List the blacklist.', A, rules.blacklistedCommand),
  g(['blacklistmode'], 'gm_bl', '/blacklistmode <delete|warn|mute|kick|ban>', 'What happens on a match.', A, rules.blacklistmodeCommand),

  // ---- 📢 reports ----
  g(['report'], 'gm_reports', '/report (reply)', 'Report a message to the admins.', P, reports.reportCommand),
  g(['reports'], 'gm_reports', '/reports', 'Open reports.', A, reports.reportsCommand),
  g(['reportmode'], 'gm_reports', '/reportmode <group|pm|off>', 'How admins are notified.', A, reports.reportmodeCommand, { menu: false }),
  g(['clearreports'], 'gm_reports', '/clearreports', 'Close all open reports.', A, reports.clearreportsCommand, { menu: false }),

  // ---- ⚙️ settings + cleanup ----
  g(['settings', 'config', 'groupconfig'], 'gm_settings', '/settings', 'Open the settings panel.', A, menu.settingsCommand),
  g(['security'], 'gm_settings', '/security', 'Security overview: anti-spam, flood, verification, locks.', A, menu.securityCommand),
  g(['settitle'], 'gm_settings', '/settitle <text>', 'Change the group title.', A, info.settitleCommand, { menu: false }),
  g(['setdescription'], 'gm_settings', '/setdescription <text>', 'Change the group description.', A, info.setdescriptionCommand, { menu: false }),
  g(['cleanservice'], 'gm_settings', '/cleanservice [on|off]', 'Delete join / leave / pin notices.', P, clean.cleanserviceCommand, { menu: false }),
  g(['cleancommands'], 'gm_settings', '/cleancommands [on|off]', 'Delete handled command messages.', P, clean.cleancommandsCommand, { menu: false }),
  g(['cleanbots'], 'gm_settings', '/cleanbots [on|off]', 'Delete inline-bot messages.', P, clean.cleanbotsCommand, { menu: false }),
  g(['cleanlinks'], 'gm_settings', '/cleanlinks [on|off]', 'Delete link messages (same as /lock links).', P, locks.cleanlinksCommand, { menu: false }),

  // ---- 📊 information ----
  g(['info', 'chatinfo'], 'gm_info', '/info', 'Group information.', P, info.infoCommand),
  g(['groupid'], 'gm_info', '/groupid', 'This group\'s chat ID.', P, info.groupidCommand, { menu: false }),
  g(['afk'], 'gm_info', '/afk [reason]', 'Mark yourself away; people who reply to you see it.', P, afk.afkCommand),
  g(['unafk'], 'gm_info', '/unafk', 'Clear your AFK status.', P, afk.unafkCommand),
  g(['approve'], 'gm_admin', '/approve (reply) | /approve [user id]', 'Exempt a member from locks, flood, spam, blacklist and captcha.', A, afk.approveCommand),
  g(['unapprove'], 'gm_admin', '/unapprove (reply) | /unapprove [user id]', 'Remove that exemption.', A, afk.unapproveCommand),
  g(['userinfo', 'whois'], 'gm_info', '/userinfo [user id]', 'Information about a member.', P, info.userinfoCommand),
  g(['link'], 'gm_info', '/link', 'Get the group link.', A, info.linkCommand),
  g(['invite'], 'gm_info', '/invite', 'Create a fresh invite link.', A, info.inviteCommand),

  // ---- 📋 history ----
  g(['modlog', 'adminlog', 'modhistory'], 'gm_log', '/modlog [user id]', 'Recent moderation events (admins only).', A, info.modlogCommand),
];

/** Documentation-only entries (shown in /help, not routable): the group variants of commands shared with the private bot. */
export const HELP_ONLY = [
  { names: ['setwelcome'], category: 'gm_welcome', usage: '/setwelcome <text> [buttons]', description: 'Set the group welcome (text, media, buttons, placeholders).', access: A, groupOnly: true, helpOnly: true },
  { names: ['resetwelcome'], category: 'gm_welcome', usage: '/resetwelcome', description: 'Restore the default group welcome.', access: A, groupOnly: true, helpOnly: true },
];

export const GROUP_CALLBACKS = {
  mod: mod.moderationCallback,
  wn: warn.warningCallback,
  vf: captcha.verifyCallback,
  rp: reports.reportCallback,
  gs: menu.settingsCallback,
  gc: filters.confirmCallback,
  ml: info.modlogCallback,
  gr: greet.rulesButtonCallback,
};

export { greet };
