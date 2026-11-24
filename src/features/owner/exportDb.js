// /export (Main Owner only): every table of the main bot database as one JSON file.
import { nowSec } from '../../utils/helpers.js';
import { messages } from '../../utils/formatter.js';
import { reply } from '../../handlers/helpers.js';
import { dayKey } from '../activity/activity.js';

const MAX_EXPORT_BYTES = 45 * 1024 * 1024; // Telegram bots can send files up to 50 MB

export async function exportCommand(ctx, msg) {
  const tables = await ctx.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const isClone = Boolean(ctx.clone);
  const data = { exported_at: nowSec(), bot: ctx.config.botName, schema: isClone ? 'clone' : 'main', tables: {} };
  for (const t of tables) {
    data.tables[t.name] = await ctx.db.all(`SELECT * FROM "${t.name.replace(/"/g, '""')}"`);
  }
  const json = JSON.stringify(data, null, 2);
  if (new TextEncoder().encode(json).length > MAX_EXPORT_BYTES) {
    return reply(ctx, msg, messages.warning('Export Too Large', 'The database is too large for one Telegram file. Please export in parts.'));
  }
  const kind = isClone ? 'clone' : 'main';
  const name = `${ctx.config.botSlug || 'bot'}-${kind}-export-${dayKey(nowSec())}.json`;
  await ctx.tg.sendDocument(msg.chat.id, json, name, { caption: `${isClone ? 'Clone bot' : 'Main bot'} export · ${Object.keys(data.tables).length} tables` });
  return undefined;
}
