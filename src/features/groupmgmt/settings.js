// Per-group configuration. Everything is stored in group_settings (group-isolated) and read with ONE query.

import { listGroupSettings, setGroupSetting, deleteGroupSetting } from '../../database/settings.js';

export const DEFAULTS = Object.freeze({
  // warnings
  'warn.limit': '3', 'warn.mode': 'mute', 'warn.mode_time': '0', 'warn.time': '0',
  // antiflood
  'flood.on': '0', 'flood.limit': '5', 'flood.window': '5', 'flood.mode': 'mute', 'flood.time': '600',
  // antispam
  'spam.on': '0', 'spam.mode': 'delete', 'spam.repeat': '3', 'spam.mentions': '6', 'spam.links': '3', 'spam.forwards': '4', 'spam.time': '600',
  // raid
  'raid.on': '0', 'raid.threshold': '10', 'raid.window': '60', 'raid.action': 'kick', 'raid.time': '1800', 'raid.until': '0',
  // captcha
  'captcha.on': '0', 'captcha.mode': 'button', 'captcha.time': '300', 'captcha.action': 'kick', 'captcha.text': '',
  // blacklist
  'bl.mode': 'delete', 'bl.n': '0', 'bl.time': '3600',
  // filters / notes
  'flt.n': '0', 'notes.public': '1',
  // welcome / goodbye
  'welcome.on': '1', 'welcome.type': 'auto', 'welcome.mute': '0', 'welcome.clean': '0', 'welcome.rules_button': '1',
  'goodbye.on': '0', 'goodbye.clean': '0',
  // reports
  'reports.mode': 'group',
  // cleanup
  'clean.service': '0', 'clean.commands': '0', 'clean.bots': '0',
  // self moderation policy
  'selfmod.on': '0',
});

export class GroupSettings {
  constructor(rows = []) {
    this.map = new Map(rows.map((r) => [r.setting_key, r.setting_value]));
  }

  get(key) {
    const v = this.map.get(key);
    return v === undefined || v === null ? (DEFAULTS[key] ?? '') : v;
  }

  bool(key) { return ['1', 'true', 'on', 'yes'].includes(String(this.get(key)).toLowerCase()); }

  int(key) {
    const n = Number.parseInt(this.get(key), 10);
    return Number.isFinite(n) ? n : Number.parseInt(DEFAULTS[key] ?? '0', 10) || 0;
  }

  /** Enabled lock types. */
  locks() {
    return new Set([...this.map.entries()].filter(([k, v]) => k.startsWith('lock.') && v === '1').map(([k]) => k.slice(5)));
  }
}

export async function loadSettings(ctx, group) {
  return new GroupSettings(await listGroupSettings(ctx.db, group));
}

export const putSetting = (ctx, group, key, value) => setGroupSetting(ctx.db, group, key, value);
export const clearSetting = (ctx, group, key) => deleteGroupSetting(ctx.db, group, key);
export const putBool = (ctx, group, key, on) => setGroupSetting(ctx.db, group, key, on ? '1' : '0');
