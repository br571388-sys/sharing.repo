// /tr, /translate — translation through a swappable provider (MyMemory by default).
// MyMemory free tier: anonymous daily allowance is small; a contact e-mail (MYMEMORY_EMAIL) raises it.
// The allowance is NOT unlimited — when it runs out the bot says so.

import { ApiError } from '../../utils/errors.js';
import { esc, messages, field } from '../../utils/formatter.js';
import { fetchWithTimeout, sha256Hex, truncate } from '../../utils/helpers.js';
import { cacheKey } from '../../services/cache.js';
import { reply, safeEdit, reactOk } from '../../handlers/helpers.js';
import { userErrorMessage } from '../../core/errorHandler.js';
import { shiftWord } from '../../utils/command.js';
import { boxHtml } from '../../ui/design.js';

export const MAX_TEXT = 1500;
const CHUNK = 450; // MyMemory accepts at most 500 bytes per request

export const LANGUAGES = {
  en: 'English', hi: 'Hindi', bn: 'Bengali', ta: 'Tamil', te: 'Telugu', mr: 'Marathi', gu: 'Gujarati', kn: 'Kannada',
  ml: 'Malayalam', pa: 'Punjabi', ur: 'Urdu', ne: 'Nepali', si: 'Sinhala', es: 'Spanish', fr: 'French', de: 'German',
  it: 'Italian', pt: 'Portuguese', ru: 'Russian', ja: 'Japanese', ko: 'Korean', 'zh-CN': 'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)', ar: 'Arabic', tr: 'Turkish', id: 'Indonesian', ms: 'Malay', th: 'Thai', vi: 'Vietnamese',
  nl: 'Dutch', pl: 'Polish', uk: 'Ukrainian', el: 'Greek', he: 'Hebrew', fa: 'Persian', sv: 'Swedish', da: 'Danish',
  fi: 'Finnish', no: 'Norwegian', cs: 'Czech', ro: 'Romanian', hu: 'Hungarian', bg: 'Bulgarian', sw: 'Swahili', fil: 'Filipino',
};

const ALIASES = { zh: 'zh-CN', cn: 'zh-CN', tw: 'zh-TW', iw: 'he', jp: 'ja', kr: 'ko', nb: 'no', tl: 'fil', pt_br: 'pt', br: 'pt' };

/** Normalises user input like "EN", "zh", "zh-cn" to a supported code, or null. */
export function normalizeLang(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (raw.toLowerCase() === 'auto') return 'auto';
  const lower = raw.toLowerCase().replace('_', '-');
  const found = Object.keys(LANGUAGES).find((c) => c.toLowerCase() === lower);
  if (found) return found;
  return ALIASES[lower] || null;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Splits text into <= size chunks on sentence/space boundaries. */
export function splitForTranslation(text, size = CHUNK) {
  const out = [];
  let rest = text.trim();
  while (rest.length > size) {
    let cut = Math.max(rest.lastIndexOf('. ', size), rest.lastIndexOf('\n', size), rest.lastIndexOf('? ', size), rest.lastIndexOf('! ', size));
    if (cut < size * 0.4) cut = rest.lastIndexOf(' ', size);
    if (cut < size * 0.4) cut = size;
    else cut += 1;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Provider interface: { name, translate(config, text, from, to) -> string } (text is already <= chunk size). */
export const providers = {
  mymemory: {
    name: 'MyMemory',
    async translate(config, text, from, to) {
      const url = new URL(config.translation.url);
      url.searchParams.set('q', text);
      url.searchParams.set('langpair', `${from === 'auto' ? 'Autodetect' : from}|${to}`);
      if (config.translation.email) url.searchParams.set('de', config.translation.email);

      let res;
      try {
        res = await fetchWithTimeout(url.toString(), { headers: { Accept: 'application/json' } }, 8000);
      } catch (e) {
        throw new ApiError(`MyMemory unreachable: ${e?.message}`, { code: 'api_unreachable', cause: e });
      }
      if (res.status === 429) throw new ApiError('MyMemory rate limited', { code: 'rate_limited', userMessage: 'The translation limit has been reached. Please try again later.' });
      let json;
      try { json = await res.json(); } catch { throw new ApiError('MyMemory returned malformed JSON', { code: 'api_malformed' }); }

      const status = Number(json.responseStatus ?? res.status);
      const translated = json?.responseData?.translatedText;
      if (json.quotaFinished || /MYMEMORY WARNING/i.test(String(translated || '')) || status === 429) {
        throw new ApiError('MyMemory daily quota reached', {
          code: 'quota',
          userMessage: 'The free daily translation allowance has been used up. Please try again later.',
        });
      }
      if (status !== 200 || typeof translated !== 'string' || !translated.trim()) {
        throw new ApiError(`MyMemory error ${status}: ${json.responseDetails || 'no translation'}`, {
          code: status === 400 ? 'bad_request' : 'api_error',
          userMessage: status === 400 ? 'That language pair is not supported by the translation service.' : undefined,
        });
      }
      return decodeEntities(translated);
    },
  },
};

export async function translateText(ctx, text, from, to) {
  const provider = providers[ctx.config.translation.provider] || providers.mymemory;
  const hash = (await sha256Hex(text)).slice(0, 24);
  const { value } = await ctx.cache.remember(cacheKey('tr', provider.name, from, to, hash), ctx.config.ttl.translate, async () => {
    const parts = [];
    for (const piece of splitForTranslation(text)) parts.push(await provider.translate(ctx.config, piece, from, to));
    return parts.join(' ');
  });
  return value;
}

export function languageList() {
  const rows = Object.entries(LANGUAGES).map(([code, name]) => `<code>${esc(code)}</code> ${esc(name)}`);
  return `${boxHtml("🌐", "Supported Languages")}\n\n${rows.join('\n')}\n\n💡 Use <code>auto</code> as the source to detect the language.`;
}

const USAGE = () => messages.usage(
  ['/tr <from> <to> <text>', '/tr <to> (as a reply to a message)', '/tr langs'],
  ['/tr en hi Hello, how are you?', '/tr hi en Namaste, aap kaise hain?'],
);

export async function translateCommand(ctx, msg, args) {
  const input = args.trim();
  if (!input) return reply(ctx, msg, USAGE());
  if (/^(langs?|languages|list)$/i.test(input)) return reply(ctx, msg, languageList());

  const first = shiftWord(input);
  const second = shiftWord(first.rest);
  let from = normalizeLang(first.word);
  let to = null;
  let text = '';

  if (from && normalizeLang(second.word) && normalizeLang(second.word) !== 'auto') {
    to = normalizeLang(second.word);
    text = second.rest;
  } else if (from && from !== 'auto' && msg.reply_to_message && !second.word) {
    to = from; from = 'auto'; // "/tr hi" as a reply: auto-detect -> hi
  } else if (from && from !== 'auto' && second.word && !normalizeLang(second.word)) {
    // "/tr hi some text" -> auto-detect source, target = hi
    to = from; from = 'auto'; text = input.slice(first.word.length).trim();
  } else if (!from) {
    return reply(ctx, msg, messages.warning('Unknown Language', `“${first.word}” is not a supported language code. Send /tr langs to see the list.`));
  } else {
    return reply(ctx, msg, USAGE());
  }

  if (!text) text = msg.reply_to_message?.text || msg.reply_to_message?.caption || '';
  text = text.trim();
  if (!text) return reply(ctx, msg, USAGE());
  if (text.length > MAX_TEXT) return reply(ctx, msg, messages.warning('Text Too Long', `Please keep the text under ${MAX_TEXT} characters (yours is ${text.length}).`));
  if (from === to) return reply(ctx, msg, messages.warning('Same Language', 'The source and target languages are identical.'));

  const loading = await reply(ctx, msg, messages.searching('🌐', 'Translating...'));
  try {
    const translated = await translateText(ctx, text, from, to);
    const fromName = from === 'auto' ? 'Auto-detected' : LANGUAGES[from];
    const out = [
      '🌐 <b>Translation Result</b>',
      field('🔤', 'Original', truncate(text, 900)),
      field('🌍', 'Translated', truncate(translated, 2200)),
      field('🗣', 'Language', `${fromName} → ${LANGUAGES[to]}`),
    ].join('\n\n');
    await safeEdit(ctx, msg.chat.id, loading.message_id, out);
    await reactOk(ctx, msg, '⚡');
  } catch (e) {
    await safeEdit(ctx, msg.chat.id, loading.message_id, userErrorMessage(e));
    throw e;
  }
  return undefined;
}
