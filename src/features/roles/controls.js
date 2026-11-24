// Main Owner controls in /panel: maintenance, stopping new clone bots, and stopping / resuming all clone bots.
// These switches are stored in bot_settings. Clone bots read them when they run (see core/maintenance.js).
import { getBotSetting, setBotSetting } from '../../database/settings.js';
import { logAudit } from '../../database/roles.js';
import { queueLog, who } from '../../core/activityLog.js';
import { developerLink } from '../../core/config.js';
import { btn, markup, urlBtn, backCloseRow } from '../../keyboards/inlineKeyboard.js';
import { blockquote, box, row } from '../../ui/design.js';
import { esc } from '../../utils/formatter.js';

export const CONTROL_VIEWS = new Set(['ct', 'mt', 'cn', 'ck']);

export async function isOn(db, key) {
  // maintenance and clones_paused default OFF; cloning_enabled defaults ON
  const def = key === 'cloning_enabled' ? '1' : '0';
  return (await getBotSetting(db, key, def)) === '1';
}

function supportButton(ctx) {
  const dev = developerLink(ctx.config);
  if (ctx.config.developerId && ctx.config.developerId > 0) return urlBtn('💬 Owner (support)', `tg://user?id=${ctx.config.developerId}`, { style: 'primary' });
  if (dev) return urlBtn('💬 Owner (support)', dev, { style: 'primary' });
  return null;
}

export async function controlScreen(ctx) {
  const maintenance = await isOn(ctx.db, 'maintenance');
  const cloning = await isOn(ctx.db, 'cloning_enabled');
  const paused = await isOn(ctx.db, 'clones_paused');
  const lines = [
    row('🛠', 'Maintenance', maintenance ? 'ON — bot answers only the owner' : 'OFF'),
    row('🧬', 'Cloning new bots', cloning ? 'Allowed' : 'Stopped (existing clones are not affected)'),
    row('🤖', 'Clone bots', paused ? 'Stopped by the owner' : 'Allowed to run'),
  ].join('\n');
  const rows = [
    [btn(`🛠 Maintenance: ${maintenance ? 'ON' : 'OFF'}`, 'pn:mt', { style: maintenance ? 'danger' : 'success' })],
    [btn(cloning ? '🧬 Stop cloning new bots' : '🧬 Allow cloning new bots', 'pn:cn', { style: cloning ? 'danger' : 'success' })],
    [btn(paused ? '▶️ Resume all clone bots' : '⏸ Stop all clone bots', 'pn:ck', { style: paused ? 'success' : 'danger' })],
    [btn('🧬 Clones (manage all)', 'cm:l:0', { style: 'primary' })],
    [btn('💘 Couple trolling lines', 'tl:v', { style: 'primary' })],
    ...(supportButton(ctx) ? [[supportButton(ctx)]] : []),
    backCloseRow('pn:m'),
  ];
  return {
    text: `${box('🎛', 'Bot Controls')}\n\n${blockquote(lines)}\n\n<i>Only the Main Owner can change these switches.</i>`,
    keyboard: markup(rows),
  };
}

/** Flips one switch. Returns a short popup text. */
export async function toggleControl(ctx, view, actor) {
  const db = ctx.db;
  const key = view === 'mt' ? 'maintenance' : view === 'cn' ? 'cloning_enabled' : 'clones_paused';
  const current = await isOn(db, key);
  // cloning_enabled is stored as '1' when allowed; the others as '1' when active
  const next = !current;
  await setBotSetting(db, key, next ? '1' : '0');
  const names = { maintenance: 'maintenance', cloning_enabled: 'cloning of new bots', clones_paused: 'clone bots' };
  await logAudit(db, { actor: actor.id, action: `control_${key}`, detail: next ? 'on' : 'off' });
  queueLog(ctx, `🎛 <b>${esc(names[key])}</b> set to <b>${next ? (key === 'cloning_enabled' ? 'allowed' : key === 'clones_paused' ? 'stopped' : 'ON') : (key === 'cloning_enabled' ? 'stopped' : key === 'clones_paused' ? 'resumed' : 'OFF')}</b> · by ${who(actor)} (panel)`);
  if (key === 'maintenance') return next ? 'Maintenance is ON.' : 'Maintenance is OFF.';
  if (key === 'cloning_enabled') return next ? 'New clone bots are allowed.' : 'New clone bots are stopped.';
  return next ? 'All clone bots are stopped.' : 'All clone bots can run again.';
}
