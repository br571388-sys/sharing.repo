// Command parsing for Telegram messages: "/cmd@BotName args".

const COMMAND_RE = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,32}))?(?=\s|$)/;

/**
 * Returns null when the text is not a command or is addressed to a different bot.
 * Otherwise { name, args, argsStart } where `args` keeps newlines (button rows rely on them)
 * and `argsStart` is the index in `text` where args begin (for entity slicing).
 */
export function parseCommand(text, botUsername = '') {
  if (typeof text !== 'string') return null;
  const m = COMMAND_RE.exec(text);
  if (!m) return null;
  const target = m[2];
  if (target && botUsername && target.toLowerCase() !== botUsername.toLowerCase()) return null;
  const rest = text.slice(m[0].length);
  const lead = rest.length - rest.replace(/^[ \t]+/, '').length;
  const argsStart = m[0].length + lead;
  return { name: m[1].toLowerCase(), args: text.slice(argsStart).replace(/^\n+/, (nl) => nl).trimEnd(), argsStart, mentioned: Boolean(target) };
}

/** First whitespace-separated token of a string and the remainder. */
export function shiftWord(text) {
  const m = /^\s*(\S+)([\s\S]*)$/.exec(String(text ?? ''));
  return m ? { word: m[1], rest: m[2].replace(/^[ \t]+/, '') } : { word: '', rest: '' };
}
