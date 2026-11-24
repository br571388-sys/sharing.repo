// Owner-only welcome customisation: /setwelcome, /setwelcomeimage, /resetwelcome.
// A new image is test-sent first; an invalid image never replaces the working one.

import { deleteBotSetting, getBotSetting, setBotSetting } from '../../database/settings.js';
import { mediaOf, resolveSmartContent } from '../../keyboards/smartContent.js';
import { entitiesToHtml, sliceWithEntities, withoutCommandEntities } from '../../utils/entities.js';
import { esc, messages } from '../../utils/formatter.js';
import { reply, visibleLength } from '../../handlers/helpers.js';
import { isHttpsUrl } from '../../utils/validation.js';
import { sendWelcome } from './start.js';
import { boxHtml, box, blockquote, row } from '../../ui/design.js';
import { btn, closeBtn, markup } from '../../keyboards/inlineKeyboard.js';
import { canUsePerm } from '../../core/captains.js';
import { logAudit } from '../../database/roles.js';

// ---------- welcome picture: AUTO PFP (owner's profile picture) or the manual image ----------

export const AUTO_PFP_KEY = 'welcome_auto_pfp';
const PFP_TTL = 3600;

/** file_id of the BOT's own profile picture (cached for an hour). Null when the bot has none. */
export async function botPfpFileId(ctx) {
  const cached = await getBotSetting(ctx.db, 'owner_pfp', '');
  const at = Number(await getBotSetting(ctx.db, 'owner_pfp_at', '0'));
  if (cached && Date.now() / 1000 - at < PFP_TTL) return cached;
  try {
    const me = await ctx.botInfo();
    const res = await ctx.tg.call('getUserProfilePhotos', { user_id: me.id, limit: 1 });
    const sizes = res?.photos?.[0];
    const fileId = sizes?.length ? sizes[sizes.length - 1].file_id : '';
    await setBotSetting(ctx.db, 'owner_pfp', fileId);
    await setBotSetting(ctx.db, 'owner_pfp_at', Math.floor(Date.now() / 1000));
    return fileId || null;
  } catch {
    return cached || null;
  }
}

export async function isAutoPfp(ctx) {
  return (await getBotSetting(ctx.db, AUTO_PFP_KEY, '0')) === '1';
}

export async function imageSettingsScreen(ctx) {
  const auto = await isAutoPfp(ctx);
  const manual = await getBotSetting(ctx.db, 'welcome_image', '');
  const source = auto ? '🤖 Auto PFP is ON: the welcome uses the bot\'s own profile picture.' : (manual ? '🖼 Auto PFP is OFF: the welcome uses the picture you set.' : '🖼 Auto PFP is OFF and no picture is set yet.');
  return {
    text: `${box('🖼', 'Welcome Picture')}\n\n${blockquote(esc(source))}\n\n${row('📌', 'Mode', auto ? 'Auto PFP' : 'Manual image', { raw: true })}\n\n<i>To set a picture manually: send a photo with <code>/setwelcomeimage</code> as caption, reply to a photo, or give an https image link.</i>`,
    keyboard: markup([
      [btn(auto ? '🤖 AUTO PFP · ON' : '🤖 AUTO PFP · OFF', 'wi:pfp', { style: auto ? 'success' : 'danger' }), btn('🖼 MANUAL IMAGE', 'wi:man', { style: 'primary' })],
      [closeBtn()],
    ]),
  };
}

/** wi:pfp (toggle auto PFP) | wi:man (switch to the manual image). Owner only; re-checked every tap. */
export async function welcomeImageCallback(ctx, cq, parts) {
  if (!(await canUsePerm(ctx, cq.from.id, 'welcome'))) return ctx.tg.answerCallbackQuery(cq.id, '🔒 Only the bot owner, or a captain allowed for this, can change this.', true);
  if (parts[1] === 'pfp') {
    const next = (await isAutoPfp(ctx)) ? '0' : '1';
    if (next === '1' && !(await botPfpFileId(ctx))) return ctx.tg.answerCallbackQuery(cq.id, 'The bot has no profile picture yet. Set one in @BotFather first.', true);
    await setBotSetting(ctx.db, AUTO_PFP_KEY, next);
    await logAudit(ctx.db, { actor: cq.from.id, action: 'welcome_auto_pfp', detail: next });
  } else if (parts[1] === 'man') {
    await setBotSetting(ctx.db, AUTO_PFP_KEY, '0');
    await logAudit(ctx.db, { actor: cq.from.id, action: 'welcome_auto_pfp', detail: '0' });
  } else return ctx.tg.answerCallbackQuery(cq.id, 'Unknown button.');
  await ctx.tg.answerCallbackQuery(cq.id);
  const s = await imageSettingsScreen(ctx);
  const m = cq.message;
  return ctx.tg.editMessageText(m.chat.id, m.message_id, s.text, { reply_markup: s.keyboard }).catch(() => ctx.tg.editMessageCaption(m.chat.id, m.message_id, s.text, { reply_markup: s.keyboard }).catch(() => {}));
}

const CAPTION_LIMIT = 1000;

export async function setWelcomeCommand(ctx, msg, args, cmd) {
  // Text, buttons and a photo are read in one go (typed or from the replied message), see keyboards/smartContent.js.
  const r = resolveSmartContent(msg, { argsStart: cmd.argsStart });
  if (r.error === 'empty') {
    return reply(ctx, msg, messages.usage(['/setwelcome <caption text> [button rows]', '/setwelcome (reply to a message or photo)'], ['/setwelcome 👋 Welcome to my bot!\n(Channel - https://t.me/example)'],
      'Formatting (bold, links…) is kept. A photo in the same message or the replied message becomes the welcome picture. Use /resetwelcome to restore the defaults.'));
  }
  if (!r.ok) return reply(ctx, msg, r.error);
  if (r.media && !PICTURE_TYPES.includes(r.media.type)) return reply(ctx, msg, messages.warning('Not A Picture', 'The welcome picture can be a photo, a video or a GIF. Use /setwelcome with one of those, or /setwelcomeimage.'));

  const html = r.text ? entitiesToHtml(r.text, r.entities) : '';
  if (r.text && visibleLength(html) > CAPTION_LIMIT) return reply(ctx, msg, messages.warning('Caption Too Long', `Welcome captions can have at most ${CAPTION_LIMIT} characters (yours has ${visibleLength(html)}).`));

  if (r.text) await setBotSetting(ctx.db, 'welcome_caption', html);
  if (r.buttons.length) await setBotSetting(ctx.db, 'welcome_buttons', JSON.stringify(r.buttons));
  if (r.media) {
    await setBotSetting(ctx.db, 'welcome_image', r.media.file_id);
    await setBotSetting(ctx.db, 'welcome_image_type', r.media.type);
    await setBotSetting(ctx.db, 'welcome_image_source', 'telegram');
    await setBotSetting(ctx.db, AUTO_PFP_KEY, '0'); // a manual picture turns Auto PFP off
  }
  await reply(ctx, msg, messages.success('Welcome Updated', 'Here is a preview of the new welcome message:'));
  return sendWelcome(ctx, msg.chat.id);
}

const PICTURE_TYPES = ['photo', 'video', 'animation']; // a photo, a video or a GIF (Telegram "animation")

/** The picture in a message: photo, video or GIF. Documents are not used (Telegram shows them as files). */
function pictureOf(m) {
  const found = mediaOf(m);
  return found && PICTURE_TYPES.includes(found.type) ? found : null;
}

/** Picks the Telegram send type for an https link from its file extension. */
function typeFromUrl(url) {
  const path = url.split('?')[0].toLowerCase();
  if (path.endsWith('.gif')) return 'animation';
  if (path.endsWith('.mp4') || path.endsWith('.webm')) return 'video';
  return 'photo';
}

function fileIdOf(sent, type) {
  if (type === 'photo') return sent?.photo?.length ? sent.photo[sent.photo.length - 1].file_id : null;
  return sent?.[type]?.file_id || null;
}

/**
 * /setwelcomeimage — the welcome picture. Accepts a photo, a video or a GIF: send it with the command as caption,
 * reply to one, or give an https link (the type is taken from the file extension).
 */
export async function setWelcomeImageCommand(ctx, msg, args) {
  const arg = args.trim();
  const found = pictureOf(msg) || pictureOf(msg.reply_to_message);
  if (!found && !arg) {
    const s = await imageSettingsScreen(ctx);
    return reply(ctx, msg, s.text, { reply_markup: s.keyboard });
  }
  let type = found?.type;
  let fileId = found?.file_id;
  let source = 'telegram';
  if (!found) {
    const isUrl = /^https?:\/\//i.test(arg);
    if (isUrl && !isHttpsUrl(arg)) return reply(ctx, msg, messages.warning('Invalid URL', 'Please provide a valid https:// link to a photo, video or GIF.'));
    if (!isUrl) return reply(ctx, msg, messages.warning('Not A Picture', 'Send a photo, video or GIF with /setwelcomeimage, reply to one, or give an https link.'));
    type = typeFromUrl(arg);
    // Test-send: proves Telegram can actually load this file before it replaces the current one.
    let sent;
    try {
      sent = await ctx.tg.sendMedia(msg.chat.id, type, arg, { caption: '🖼 <b>Welcome picture preview</b>' });
    } catch (e) {
      return reply(ctx, msg, messages.error('Invalid Picture', `Telegram could not use that link, so the current welcome picture was kept.\n${e.message}`));
    }
    fileId = fileIdOf(sent, type) || arg;
    source = arg;
  }
  await setBotSetting(ctx.db, 'welcome_image', fileId);
  await setBotSetting(ctx.db, 'welcome_image_type', type);
  await setBotSetting(ctx.db, 'welcome_image_source', source);
  await setBotSetting(ctx.db, AUTO_PFP_KEY, '0'); // a manual picture turns Auto PFP off
  return reply(ctx, msg, messages.success('Welcome Picture Updated', `New users will see this ${type === 'photo' ? 'photo' : type === 'video' ? 'video' : 'GIF'} when they send /start.`));
}

export async function resetWelcomeCommand(ctx, msg, args) {
  const what = args.trim().toLowerCase() || 'all';
  if (!['all', 'image', 'caption', 'buttons'].includes(what)) return reply(ctx, msg, messages.usage(['/resetwelcome [all|image|caption|buttons]']));
  if (what === 'all' || what === 'image') { await deleteBotSetting(ctx.db, 'welcome_image'); await deleteBotSetting(ctx.db, 'welcome_image_type'); await deleteBotSetting(ctx.db, 'welcome_image_source'); }
  if (what === 'all' || what === 'caption') await deleteBotSetting(ctx.db, 'welcome_caption');
  if (what === 'all' || what === 'buttons') await deleteBotSetting(ctx.db, 'welcome_buttons');
  return reply(ctx, msg, messages.success('Welcome Reset', `The welcome ${what === 'all' ? 'message' : what} was restored to the default.`));
}

export { getBotSetting };
