// Command table: the single source of truth for routing, permissions, rate limits, help menu and the
// Telegram command menus. To add a command, add one entry here.
//
// access: public | owner | sudo | groupAdmin | groupManage | backup   (see core/permissions.js)
// groupAccess: optional override of `access` when used inside a group (e.g. /button is public in private chats
//              but limited to administrators in groups so it cannot be used to spam).

import { startCommand, helpCommand, aboutCommand, idCommand, pingCommand } from '../features/start/start.js';
import { animeCommand } from '../features/anime/animeInfo.js';
import { scheduleCommand } from '../features/anime/animeSchedule.js';
import { translateCommand } from '../features/translation/translate.js';
import { imageCommand } from '../features/imageSearch/imageSearch.js';
import { buttonCommand } from '../features/buttons/buttonBuilder.js';
import { announceCommand, broadcastCommand, broadcastStatusCommand } from '../features/broadcast/broadcast.js';
import { backupCommand } from '../features/backup/manualBackup.js';
import { importCommand } from '../features/backup/import.js';
import { dashboardCommand } from '../features/dashboard/dashboard.js';
import { resetWelcomeCommand, setWelcomeCommand, setWelcomeImageCommand } from '../features/start/welcomeSettings.js';
import {
  authorizeCommand, groupAdminsCommand, groupInfoCommand, registerOwnerCommand, unauthorizeCommand,
} from '../features/groups/groupManagement.js';

import { sudoCommand } from '../features/roles/sudo.js';
import { setlogchannelCommand, buttonstyleCommand } from '../features/owner/ownerTools.js';
import { botlinksCommand } from '../features/owner/botlinks.js';
import { getidCommand } from '../features/roles/getid.js';
import { toSmallCaps } from '../ui/typography.js';
import { panelCommand } from '../features/roles/panel.js';
import { allCommand, atagCommand } from '../features/groupmgmt/mention.js';
import { leaderboardCommand } from '../features/activity/leaderboard.js';
import { clonebotCommand, myCloneCommand, cloneLinkCommand } from '../features/clones/clonebot.js';
import { coupleCommand, mypartnerCommand } from '../features/couple/couple.js';
import { exportCommand } from '../features/owner/exportDb.js';
import { gbanCommand, gbaninfoCommand, gbanlistCommand, ungbanCommand } from '../features/roles/gban.js';
import { GROUP_COMMANDS, HELP_ONLY, greet } from './groupCommands.js';

/** /setwelcome and /resetwelcome: the bot owner edits the private /start welcome; group admins edit THAT group's welcome. */
const byChat = (privateRun, groupRun) => (ctx, msg, args, cmd) => (msg.chat.type === 'private' ? privateRun : groupRun)(ctx, msg, args, cmd);

export const COMMANDS = [
  // ---- basics ----
  { names: ['start'], category: 'general', usage: '/start', description: 'Open the welcome menu.', access: 'public', run: startCommand },
  { names: ['help'], category: 'general', usage: '/help [command]', description: 'Open the main menu, or show help for one command.', access: 'public', run: helpCommand },
  { names: ['about'], category: 'general', usage: '/about', description: 'About this bot.', access: 'public', run: aboutCommand },
  { names: ['id'], category: 'general', usage: '/id', description: 'Show your Telegram ID (reply to someone to see theirs).', access: 'public', run: idCommand },
  { names: ['ping'], category: 'general', usage: '/ping', description: 'Check that the bot is responding.', access: 'public', run: pingCommand },

  // ---- anime ----
  { names: ['anime', 'animeinfo'], category: 'anime', usage: '/anime <name>', description: 'Anime details: titles, score, genres, studio, next episode.', access: 'public', rate: true, run: animeCommand },
  { names: ['schedule', 'animeschedule', 'airing'], category: 'anime', usage: '/schedule [today|tomorrow|week|<anime>]', description: 'Airing schedule in IST, or the next episode of one anime.', access: 'public', rate: true, run: scheduleCommand },

  // ---- translation / images ----
  { names: ['tr', 'translate'], category: 'translate', usage: '/tr <from> <to> <text>', description: 'Translate text (e.g. /tr en hi Hello). /tr langs lists languages.', access: 'public', rate: true, run: translateCommand },
  { names: ['image', 'img', 'imagesearch'], category: 'image', usage: '/image <search term>', description: 'Search images with Next/Previous buttons.', access: 'public', rate: true, run: imageCommand },

  // ---- button builder ----
  { names: ['button', 'buttons'], category: 'buttons', usage: ['/button <text> + button rows', '(Site - https://example.com) = green | (Ask - Hi there!) = red'], description: 'Inline buttons: (Label - link) or (Label - text) pop-up, add = red / blue / green for colour, | = same row.', access: 'public', groupAccess: 'groupAdmin', run: buttonCommand },

  // ---- broadcast ----
  { names: ['broadcast'], category: 'broadcast', usage: '/broadcast [users|groups|all] <text | reply>', description: 'Broadcast a message (text, media, buttons) with a preview and confirmation. Owner and captains only.', access: 'captain', run: broadcastCommand },
  { names: ['allbroadcast'], category: 'broadcast', usage: '/allbroadcast <text | reply>', description: 'Broadcast to all users AND all groups.', access: 'captain', run: broadcastCommand },
  { names: ['broadcaststatus'], category: 'broadcast', usage: '/broadcaststatus [id]', description: 'Progress of a broadcast.', access: 'captain', run: broadcastStatusCommand },
  { names: ['clonebot'], category: 'general', usage: '/clonebot', description: 'Create your own clone bot (send the BotFather token, then your Turso database).', access: 'public', run: clonebotCommand },
  { names: ['myclone'], category: 'general', usage: '/myclone', description: 'Manage your clone bots: status, stop, restart, reset, delete database, maintenance.', access: 'public', run: myCloneCommand },
  { names: ['clone'], category: 'general', usage: '/clone', description: 'Open the main bot to make your own clone bot.', access: 'public', run: cloneLinkCommand },
  { names: ['leaderboard'], category: 'groups', usage: '/leaderboard', description: 'Top 10 members of this group by message count: today, weekly or monthly.', access: 'public', groupOnly: true, run: leaderboardCommand },
  { names: ['couple'], category: 'groups', usage: '/couple', description: 'Pick 10 random couples from active members (once every 24 hours).', access: 'groupMention', groupOnly: true, run: coupleCommand },
  { names: ['mypartner'], category: 'groups', usage: '/mypartner', description: 'Show your partner from today\'s couples.', access: 'public', groupOnly: true, run: mypartnerCommand },
  { names: ['export'], category: 'ownerRoles', usage: '/export', description: 'Download the complete main bot database as one JSON file (owner only).', access: 'owner', run: exportCommand },
  { names: ['all'], category: 'groups', usage: '/all [reply]', description: 'Mention every known member of this group (reply to a message to keep its context).', access: 'groupMention', groupOnly: true, run: allCommand },
  { names: ['atag'], category: 'groups', usage: '/atag [reply]', description: 'Mention only this group\'s administrators (reply to keep the context).', access: 'groupMention', groupOnly: true, run: atagCommand },
  { names: ['announce'], category: 'gm_msg', usage: '/announce [pin] <text | reply>', description: 'Post an announcement (with buttons) in this group.', access: 'groupAdmin', groupOnly: true, run: announceCommand },

  // ---- backup ----
  { names: ['backup'], category: 'backup', usage: '/backup', description: 'Create a backup (full bot in private chat for the owner; this group for its owner).', access: 'backup', run: backupCommand },
  { names: ['import'], category: 'backup', usage: '/import (reply to a backup file)', description: 'Validate and restore a backup after confirmation.', access: 'backup', run: importCommand },

  // ---- group tools ----
  { names: ['groupinfo'], category: 'groups', usage: '/groupinfo', description: 'Show this group\'s registration, owner and authorised admins.', access: 'groupAdmin', groupOnly: true, run: groupInfoCommand },
  { names: ['registerowner'], category: 'groups', usage: '/registerowner', description: 'Register yourself as group owner when Telegram cannot identify one.', access: 'groupAdmin', groupOnly: true, run: registerOwnerCommand },
  { names: ['authorize'], category: 'groups', usage: '/authorize (reply to an admin)', description: 'Let another admin back up / restore this group.', access: 'groupManage', groupOnly: true, run: authorizeCommand },
  { names: ['unauthorize'], category: 'groups', usage: '/unauthorize (reply to an admin)', description: 'Remove that permission.', access: 'groupManage', groupOnly: true, run: unauthorizeCommand },
  { names: ['groupadmins'], category: 'groups', usage: '/groupadmins', description: 'List authorised administrators.', access: 'groupAdmin', groupOnly: true, run: groupAdminsCommand },

  // ---- owner ----
  { names: ['dashboard'], category: 'dashboard', usage: '/dashboard', description: 'Users, groups, broadcasts, backups and system status.', access: 'owner', run: dashboardCommand },
  { names: ['setwelcome'], category: 'dashboard', usage: '/setwelcome <caption> [buttons]', description: 'Change the /start welcome text and extra buttons.', access: 'perm:welcome', groupAccess: 'groupAdmin', run: byChat(setWelcomeCommand, greet.setgroupwelcomeCommand) },
  { names: ['setwelcomeimage'], category: 'dashboard', usage: '/setwelcomeimage <url | photo>', description: 'Change the /start welcome image (tested before saving).', access: 'perm:welcome', run: setWelcomeImageCommand },
  { names: ['resetwelcome'], category: 'dashboard', usage: '/resetwelcome [all|image|caption|buttons]', description: 'Restore the default welcome.', access: 'perm:welcome', groupAccess: 'groupAdmin', run: byChat(resetWelcomeCommand, greet.resetgroupwelcomeCommand) },
  // ---- moderators: owner + sudo users (hidden from everybody else; enforced server-side in core/permissions.js) ----
  { names: ['panel'], category: 'mod', usage: '/panel', description: 'Moderator dashboard: users, groups, bans, usage and activity. Owner: manage sudo, captains and their permissions, send them messages.', access: 'sudo', run: panelCommand },
  { names: ['gban'], category: 'mod', usage: '/gban USER_ID [reason]', description: 'Ban a user in every group where the bot is an admin (reply works too).', access: 'sudo', run: gbanCommand },
  { names: ['ungban'], category: 'mod', usage: '/ungban USER_ID', description: 'Lift a global ban everywhere.', access: 'sudo', run: ungbanCommand },
  { names: ['gbanlist'], category: 'mod', usage: '/gbanlist', description: 'List globally banned users.', access: 'sudo', run: gbanlistCommand },
  { names: ['getid'], category: 'mod', usage: '/getid <user id | channel id | @username>', description: 'Profile or channel link for an ID, username or channel.', access: 'sudo', run: getidCommand },
  { names: ['gbaninfo'], category: 'mod', usage: '/gbaninfo USER_ID', description: 'Who banned them, why, and where it was applied.', access: 'sudo', run: gbaninfoCommand },
  // ---- main owner only ----
  { names: ['setlogchannel'], category: 'dashboard', usage: '/setlogchannel <channel id> | off', description: 'Send every bot activity to a log channel.', access: 'perm:logs', run: setlogchannelCommand },
  { names: ['botlinks'], category: 'dashboard', usage: '/botlinks', description: 'Direct buttons to /setup, /status (stats) and /health.', access: 'owner', run: botlinksCommand },
  { names: ['buttonstyle'], category: 'dashboard', usage: '/buttonstyle', description: 'Switch button labels between block + bold and italic + bold.', access: 'perm:buttons', run: buttonstyleCommand },
  { names: ['sudo'], category: 'ownerRoles', usage: '/sudo add|remove|list [USER_ID]', description: 'Add or remove sudo moderators (rank below the owner). Captains and messages are managed in /panel.', access: 'owner', run: sudoCommand },
  ...GROUP_COMMANDS,
  ...HELP_ONLY,
];

const byName = new Map();
for (const c of COMMANDS) if (!c.helpOnly) for (const n of c.names) byName.set(n, c);

export const findCommand = (name) => byName.get(name) || null;

/** Command lists for setMyCommands, per audience. */
export function menuCommands(audience) {
  const allowed = {
    default: ['public'],
    admins: ['public', 'groupAdmin', 'groupManage', 'backup'],
    owner: ['public', 'owner', 'sudo', 'backup', 'groupAdmin', 'groupManage', 'groupMention', 'perm:welcome', 'perm:buttons', 'perm:logs'],
    sudo: ['public', 'sudo'],
    groups: ['public'],
  }[audience];
  const out = [];
  for (const c of COMMANDS) {
    if (c.helpOnly || c.menu === false) continue;
    if (!allowed.includes(c.access)) continue;
    if (audience === 'default' && c.groupOnly) continue;
    if ((audience === 'owner' || audience === 'sudo') && c.groupOnly) continue;
    if (audience === 'groups' && !(c.groupOnly || ['help', 'about', 'ping', 'id'].includes(c.names[0]) || c.groupAccess)) continue;
    if (c.names[0] === 'start' && audience === 'admins') continue;
    out.push({ command: c.names[0], description: toSmallCaps(c.description.replace(/\s+/g, ' ')).slice(0, 120) });
  }
  return out.slice(0, 100); // Telegram allows at most 100 commands per menu
}
