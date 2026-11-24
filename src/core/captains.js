// Captains: sudo moderators who also get /broadcast and /allbroadcast. Stored as a list of user ids in bot_settings,
// so no migration is needed. A captain must still be a sudo user; removing sudo removes the captain rank too.
//
// Captains can also get extra permissions from the owner (in /panel): each permission unlocks one group of commands.
// Stored as { "<userId>": ["welcome", ...] } under the 'captain_perms' setting.
import { getBotSetting, setBotSetting } from '../database/settings.js';
import { isSudoUser } from '../database/roles.js';

const KEY = 'captains';
const PERMS_KEY = 'captain_perms';

/** The permissions the owner can give a captain, with the commands each one unlocks. */
export const CAPTAIN_PERMS = {
  welcome: { label: 'Welcome', commands: '/setwelcome, /setwelcomeimage, /resetwelcome' },
  buttons: { label: 'Button style', commands: '/buttonstyle' },
  logs: { label: 'Log channel', commands: '/setlogchannel' },
};

export async function captainIds(db) {
  try {
    const list = JSON.parse(await getBotSetting(db, KEY, '[]'));
    return Array.isArray(list) ? list.map(Number) : [];
  } catch { return []; }
}

async function permMap(db) {
  try {
    const map = JSON.parse(await getBotSetting(db, PERMS_KEY, '{}'));
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  } catch { return {}; }
}

export async function setCaptain(db, userId, on) {
  const ids = new Set(await captainIds(db));
  if (on) ids.add(Number(userId)); else ids.delete(Number(userId));
  await setBotSetting(db, KEY, JSON.stringify([...ids]));
  if (!on) { // demoting a captain also removes their extra permissions
    const map = await permMap(db);
    delete map[String(userId)];
    await setBotSetting(db, PERMS_KEY, JSON.stringify(map));
  }
}

export async function isCaptain(db, userId) {
  return (await captainIds(db)).includes(Number(userId)) && (await isSudoUser(db, userId).catch(() => false));
}

/** The extra permissions a captain holds (empty for non-captains). */
export async function captainPerms(db, userId) {
  if (!(await isCaptain(db, userId))) return [];
  const list = (await permMap(db))[String(userId)];
  return Array.isArray(list) ? list.filter((k) => k in CAPTAIN_PERMS) : [];
}

export async function setCaptainPerm(db, userId, perm, on) {
  const map = await permMap(db);
  const set = new Set(Array.isArray(map[String(userId)]) ? map[String(userId)] : []);
  if (on) set.add(perm); else set.delete(perm);
  map[String(userId)] = [...set];
  await setBotSetting(db, PERMS_KEY, JSON.stringify(map));
}

const isOwnerId = (ctx, userId) => ctx.config.ownerId !== null && userId !== undefined && Number(userId) === ctx.config.ownerId;

/** Who may broadcast: the Main Owner, or a captain. */
export async function canBroadcast(ctx, userId) {
  if (ctx.clone) {
    // inside a clone: its owner or moderators, and only after the Main Owner approved broadcast
    if (!ctx.clone.broadcastApproved) return false;
    return isOwnerId(ctx, userId) || (await isSudoUser(ctx.db, userId).catch(() => false));
  }
  return isOwnerId(ctx, userId) || isCaptain(ctx.db, userId);
}

/** Who may use a command group: the Main Owner, or a captain the owner gave that permission. */
export async function canUsePerm(ctx, userId, perm) {
  if (isOwnerId(ctx, userId)) return true;
  return (await captainPerms(ctx.db, userId)).includes(perm);
}
