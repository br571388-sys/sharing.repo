// Helpers for slicing Telegram message text together with its entities (bold, links, spoilers...).
// Telegram entity offsets are UTF-16 code units, which matches JavaScript string indices.

/**
 * Take text.slice(start, end), trim it, and rebase the entities so formatting survives.
 * Returns { text, entities }.
 */
export function sliceWithEntities(text, entities = [], start = 0, end = text.length) {
  let s = Math.max(0, start);
  let e = Math.min(text.length, end);
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;

  const out = [];
  for (const ent of entities || []) {
    const from = Math.max(ent.offset, s);
    const to = Math.min(ent.offset + ent.length, e);
    if (to > from) out.push({ ...ent, offset: from - s, length: to - from });
  }
  return { text: text.slice(s, e), entities: out };
}

const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Converts Telegram text + entities into Telegram-HTML (used to store formatted captions). */
export function entitiesToHtml(text, entities = []) {
  const tags = {
    bold: ['<b>', '</b>'], italic: ['<i>', '</i>'], underline: ['<u>', '</u>'], strikethrough: ['<s>', '</s>'],
    spoiler: ['<tg-spoiler>', '</tg-spoiler>'], code: ['<code>', '</code>'], blockquote: ['<blockquote>', '</blockquote>'],
    expandable_blockquote: ['<blockquote expandable>', '</blockquote>'],
  };
  const open = new Map();
  const close = new Map();
  const add = (map, pos, tag) => { if (!map.has(pos)) map.set(pos, []); map.get(pos).push(tag); };
  const sorted = [...(entities || [])].sort((a, b) => a.offset - b.offset || b.length - a.length);
  for (const e of sorted) {
    let pair = tags[e.type];
    if (e.type === 'pre') pair = e.language ? [`<pre><code class="language-${escHtml(e.language).replace(/"/g, '')}">`, '</code></pre>'] : ['<pre>', '</pre>'];
    if (e.type === 'text_link' && e.url) pair = [`<a href="${escHtml(e.url).replace(/"/g, '&quot;')}">`, '</a>'];
    if (e.type === 'text_mention' && e.user) pair = [`<a href="tg://user?id=${Number(e.user.id)}">`, '</a>'];
    if (!pair) continue;
    add(open, e.offset, pair[0]);
    add(close, e.offset + e.length, pair[1]);
  }
  let out = '';
  for (let i = 0; i <= text.length; i++) {
    if (close.has(i)) out += close.get(i).reverse().join('');
    if (open.has(i)) out += open.get(i).join('');
    if (i < text.length) out += escHtml(text[i]);
  }
  return out;
}

/** Telegram bot_command entities must not be forwarded in broadcast text; drop them. */
export function withoutCommandEntities(entities = []) {
  return (entities || []).filter((e) => e.type !== 'bot_command');
}
