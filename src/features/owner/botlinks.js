// /botlinks (owner only): one tap opens the bot's web pages (/setup, /status, /health).

import { getBotSetting } from '../../database/settings.js';
import { baseUrlFromEnv } from '../../core/urls.js';
import { closeBtn, markup, urlBtn } from '../../keyboards/inlineKeyboard.js';
import { box, row } from '../../ui/design.js';
import { esc, messages } from '../../utils/formatter.js';
import { reply } from '../../handlers/helpers.js';
import { isHttpUrl } from '../../utils/validation.js';

// /stats is shown as /status: the bot has no separate stats page, /status is the admin status page.
const PAGES = [
  { icon: '⚙️', name: 'Setup', path: '/setup', button: '⚙️ Setup' },
  { icon: '📊', name: 'Stats', path: '/status', button: '📊 Stats' },
  { icon: '❤️', name: 'Health', path: '/health', button: '❤️ Health' },
];

export async function botlinksCommand(ctx, msg) {
  // Base URL: PUBLIC_BASE_URL, else the URL recorded the last time /setup was opened.
  const recorded = await getBotSetting(ctx.db, 'public_base_url', '');
  const base = baseUrlFromEnv(ctx.config, recorded).replace(/\/+$/, '');
  if (!base || !isHttpUrl(base) || !base.startsWith('https://')) {
    return reply(ctx, msg, messages.warning('Base URL Unknown', 'Set PUBLIC_BASE_URL in wrangler.toml, or open /setup once in your browser so the bot can detect the link.'));
  }
  const lines = PAGES.map((p) => row(p.icon, p.name, `<code>${esc(base + p.path)}</code>`, { raw: true })).join('\n');
  const text = `${box('🔗', 'Bot Links')}\n\n${lines}\n\n<blockquote>Tap a button to open the page. /setup and /status ask for SETUP_SECRET.</blockquote>`;
  const keyboard = markup([
    ...PAGES.map((p) => [urlBtn(p.button, base + p.path, { style: 'primary' })]),
    [closeBtn()],
  ]);
  return reply(ctx, msg, text, { reply_markup: keyboard });
}
