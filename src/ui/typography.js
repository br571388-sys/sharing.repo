// Typography system. Telegram offers no font selection, so "fonts" are Unicode Mathematical Alphanumeric
// look-alikes plus real Telegram HTML formatting. Rules (kept deliberately small, never mixed randomly):
//
//   headings      -> sans-serif BOLD, upper case     𝗚𝗥𝗢𝗨𝗣 𝗠𝗔𝗡𝗔𝗚𝗘𝗠𝗘𝗡𝗧
//   sub-headings  -> sans-serif ITALIC               𝘊𝘰𝘮𝘮𝘢𝘯𝘥 𝘐𝘯𝘧𝘰𝘳𝘮𝘢𝘵𝘪𝘰𝘯
//   button labels -> sans-serif BOLD, upper case      𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦
//   body text     -> plain text (real <b> for values; never decorated)
//
// Only the 52 ASCII letters are ever converted. Digits, punctuation, emoji, HTML tags/entities, command names,
// IDs, URLs and callback data are left exactly as they are. Because the styled characters are compatibility
// forms, `normalizePlain()` (NFKC) turns them back into ordinary text (used by tests and search-friendly code).

const START = {
  serifBold: [0x1d400, 0x1d41a],
  sansBold: [0x1d5d4, 0x1d5ee],
  sansItalic: [0x1d608, 0x1d622],
  sansBoldItalic: [0x1d63c, 0x1d656],
};

function convert(text, [upper, lower], { skipEntities = true, caps = false } = {}) {
  let out = '';
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (skipEntities && ch === '&') {
      const m = /^&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/.exec(s.slice(i, i + 12));
      if (m) { out += m[0]; i += m[0].length - 1; continue; }
    }
    const c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90) out += String.fromCodePoint(upper + (c - 65));
    else if (c >= 97 && c <= 122) out += String.fromCodePoint(caps ? upper + (c - 97) : lower + (c - 97));
    else out += ch;
  }
  return out;
}

export const toSerifBold = (t) => convert(t, START.serifBold);
export const toSansBold = (t) => convert(t, START.sansBold);
export const toSansItalic = (t) => convert(t, START.sansItalic);

/** Main heading: sans-serif bold capitals. */
export const heading = (text) => convert(text, START.sansBold, { caps: true });
/** Sub-heading: sans-serif italic, original capitalisation. */
export const toSansBoldItalic = (t) => convert(t, START.sansBoldItalic);
/** Sub-heading / section label: sans-serif BOLD ITALIC (𝘏𝘦𝘭𝘭𝘰). */
export const subheading = (text) => toSansBoldItalic(text);

const EMOJI_PREFIX = /^((?:[\p{Extended_Pictographic}\p{Regional_Indicator}️‍⃣•◀▶⬅➡↩✖✔❌✅]+\s*)+)/u;

// Button style chosen by the owner with /buttonstyle:
//   block  -> sans-serif BOLD CAPITALS     𝗛𝗘𝗟𝗟𝗢 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦
//   italic -> sans-serif BOLD ITALIC, first letter capital, rest normal   𝘏𝘦𝘭𝘭𝘰 𝘊𝘰𝘮𝘮𝘢𝘯𝘥𝘴
export const BUTTON_MODES = ['block', 'italic'];
let buttonMode = 'block';
export function setButtonMode(mode) { if (BUTTON_MODES.includes(mode)) buttonMode = mode; }
export const currentButtonMode = () => buttonMode;

/** Button label: keeps any leading emoji and applies the owner's chosen button style. */
export function buttonLabel(text) {
  const s = String(text ?? '');
  const m = EMOJI_PREFIX.exec(s);
  const prefix = m ? m[1] : '';
  const rest = s.slice(prefix.length);
  if (buttonMode === 'italic') {
    const lower = rest.toLowerCase();
    return prefix + convert(lower.charAt(0).toUpperCase() + lower.slice(1), START.sansBoldItalic);
  }
  return prefix + convert(rest, START.sansBold, { caps: true });
}

/** Converts styled Unicode back to ordinary letters (NFKC). */
export const normalizePlain = (t) => String(t ?? '').normalize('NFKC');

/** Small caps (ᴀʙᴄ…) for Telegram's command menu descriptions. Command names themselves must stay plain a-z. */
const SMALL_CAPS = { a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ', s: 'ꜱ', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ' };
export const toSmallCaps = (t) => String(t ?? '').replace(/[a-z]/gi, (ch) => SMALL_CAPS[ch.toLowerCase()]);
