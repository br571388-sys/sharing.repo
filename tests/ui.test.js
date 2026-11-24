import test from 'node:test';
import assert from 'node:assert/strict';
import { processUpdate } from '../src/core/webhook.js';
import { buttonLabel, heading, normalizePlain, subheading, toSansBold } from '../src/ui/typography.js';
import { configureUi, inferStyle } from '../src/ui/buttons.js';
import { box, formatCommandHelp, formatModerationLog, formatWelcome, onOff } from '../src/ui/design.js';
import { btn, markup, urlBtn } from '../src/keyboards/inlineKeyboard.js';
import { CATEGORIES, SECTIONS, helpCategoryScreen, helpMainScreen, helpSectionScreen } from '../src/features/start/start.js';
import { visibleLength } from '../src/handlers/helpers.js';
import { welcomePic, BOT_ID, callbackQuery, groupMsg, makeCtx, privateMsg, update, OWNER } from './helpers/fakes.js';

const norm = (s) => String(s).normalize('NFKC');
const plain = (s) => norm(String(s).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));

/** Every opened tag is closed in order (Telegram rejects malformed HTML). */
function balanced(html) {
  const stack = [];
  for (const m of String(html).matchAll(/<(\/?)([a-z]+)(?:\s[^>]*)?>/gi)) {
    if (m[1]) { if (stack.pop() !== m[2].toLowerCase()) return false; } else stack.push(m[2].toLowerCase());
  }
  return stack.length === 0;
}
const buttonsOf = (markupObj) => (markupObj?.inline_keyboard || []).flat();

test('typography: only ASCII letters change; entities, digits, commands, ids and urls stay intact', () => {
  assert.equal(normalizePlain(heading('Group management')), 'GROUP MANAGEMENT');
  assert.equal(normalizePlain(subheading('Command Information')), 'Command Information');
  assert.equal(heading('Ban &amp; more'), `${heading('Ban')} &amp; ${heading('more')}`);
  assert.equal(heading('a &lt;b&gt;').includes('&lt;') && heading('a &lt;b&gt;').includes('&gt;'), true);
  assert.equal(buttonLabel('⚙️ Commands'), `⚙️ ${toSansBold('COMMANDS')}`);
  assert.equal(buttonLabel('1/3'), '1/3');
  assert.equal(buttonLabel('◀️ Back').startsWith('◀️ '), true);
  assert.notEqual(heading('x'), subheading('x'), 'headings and sub-headings use different styles');
});

test('buttons: bold labels + colours; callback_data and urls are never altered', () => {
  configureUi({ styles: true, fancy: true });
  const b = btn('⚙️ Commands', 'm:help');
  assert.equal(b.callback_data, 'm:help');
  assert.equal(norm(b.text), '⚙️ COMMANDS');
  assert.equal(b.style, 'primary');
  assert.equal(btn('❌ Close', 'x:close').style, 'danger');
  assert.equal(btn('✅ Confirm Import', 'imp:go:1').style, 'success');
  assert.equal(btn('✅ Yes, delete all', 'gc:notes:go').style, 'danger', 'destructive confirmation is red');
  assert.equal(btn('Next ▶️', 'x').style, 'primary', 'navigation is blue');
  assert.equal(btn('🔔 Notifications', 'x').style, undefined, 'plain settings stay neutral');
  assert.equal(urlBtn('➕ Add Me To Your Group', 'https://t.me/x', { style: 'success' }).url, 'https://t.me/x');
  assert.equal(btn('Anime Title', 'an:A:1', { plain: true }).text, 'Anime Title', 'dynamic text can stay plain');
  assert.equal(inferStyle('🔓 Unban'), undefined);
  assert.equal(markup([[btn('Help', 'a')]]).inline_keyboard[0][0].style, 'primary', 'markup() keeps style');
});

test('UI_BUTTON_STYLES=false / UI_FANCY_BUTTONS=false switch the look off (presentation only)', () => {
  configureUi({ styles: false, fancy: false });
  const b = btn('❌ Close', 'x:close');
  assert.equal(b.style, undefined);
  assert.equal(b.text, '❌ Close');
  configureUi({ styles: true, fancy: true });
});

test('design helpers: boxed headings, welcome, status and command cards are well-formed', () => {
  assert.match(box("✨", "Hello"), /^<blockquote>✨ .+<\/blockquote>$/, "every heading is a quotation block");
  const w = formatWelcome({ botName: 'Nobara', firstName: 'A<B>', version: '2.0.0' });
  assert.ok(balanced(w));
  assert.match(norm(w), /WELCOME!/);
  assert.match(norm(w), /Welcome to <b>Nobara<\/b>!/);
  assert.match(w, /A&lt;B&gt;/, 'first name escaped');
  assert.ok(visibleLength(w) < 1000, 'fits a photo caption');
  assert.equal(onOff(true), '🟢 ON');
  assert.equal(onOff(false), '🔴 OFF');
  const card = formatCommandHelp({ names: ['ban', 'b'], usage: ['/ban (reply) [reason]', '/ban <id>'], description: 'Ban a member.' }, { access: 'Group administrators' });
  assert.ok(balanced(card));
  assert.match(norm(card), /BAN COMMAND/);
  assert.match(card, /&lt;id&gt;/);
  assert.match(norm(card), /Aliases/);
  assert.ok(balanced(formatModerationLog({ emoji: '🚫', titleText: 'User Banned', fields: [['👤', 'User', '<b>x</b>']], note: 'a<b' })));
});

test('every help screen is within Telegram limits, balanced, and its callbacks fit 64 bytes', async () => {
  const f = await makeCtx();
  const owner = { id: OWNER, first_name: 'Owner' };
  const chats = [{ id: OWNER, type: 'private' }, { id: -777, type: 'supergroup' }];
  f.tg.setMember(-777, OWNER, 'creator');
  let screens = 0;
  for (const chat of chats) {
    const main = await helpMainScreen(f.ctx, chat, owner);
    const all = [main];
    for (const s of SECTIONS) { const sc = await helpSectionScreen(f.ctx, chat, owner, s.id); if (sc) all.push(sc); }
    for (const c of CATEGORIES) {
      for (let p = 0; p < 4; p++) { const sc = await helpCategoryScreen(f.ctx, chat, owner, c.id, p); if (sc) all.push(sc); }
    }
    for (const sc of all) {
      screens++;
      assert.ok(balanced(sc.text), sc.text.slice(0, 80));
      assert.ok(visibleLength(sc.text) <= 4096, 'message limit');
      for (const b of buttonsOf(sc.keyboard)) {
        if (b.callback_data) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
        assert.ok(b.text.length > 0);
      }
      const rows = sc.keyboard.inline_keyboard;
      assert.ok(rows.every((r) => r.length >= 1 && r.length <= 3), 'balanced rows');
    }
  }
  assert.ok(screens > 30, `rendered ${screens} screens`);
});

test('the default welcome caption fits Telegram and the owner caption is never restyled', async () => {
  const f = await makeCtx({ env: { WELCOME_IMAGE: 'https://img.example.com/w.jpg' } });
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/start', { from: { id: 5, first_name: 'Rin' } }) }));
  const photo = welcomePic(f.tg).params;
  assert.ok(visibleLength(photo.caption) <= 1024);
  assert.match(plain(photo.caption), /Hey Rin/);
  // owner custom caption is shown exactly as stored
  await processUpdate(f.ctx, update({ message: privateMsg(OWNER, '/setwelcome <b>My</b> own caption') }));
  f.tg.reset();
  await processUpdate(f.ctx, update({ message: privateMsg(5, '/start') }));
  assert.doesNotMatch(norm(welcomePic(f.tg).params.caption), /WELCOME!/);
  assert.match(welcomePic(f.tg).params.caption, /own caption/);
});

// ------------------------------------------------------------------ moderation UI

const CHAT = -8100;
const ADMIN = 10;
const TARGET = 50000;
const FULL = { can_delete_messages: true, can_restrict_members: true, can_promote_members: true, can_pin_messages: true, can_change_info: true, can_invite_users: true };
async function group() {
  const f = await makeCtx();
  f.tg.setMember(CHAT, BOT_ID, 'administrator', { ...FULL, user: { id: BOT_ID, is_bot: true } });
  f.tg.setMember(CHAT, ADMIN, 'administrator', { ...FULL, user: { id: ADMIN, first_name: 'Boss' } });
  f.tg.setMember(CHAT, TARGET, 'member', { user: { id: TARGET, first_name: 'Tgt' } });
  f.say = async (userId, text, extra = {}) => { f.tg.reset(); await processUpdate(f.ctx, update({ message: groupMsg(CHAT, userId, text, extra) })); return f.tg.sent('sendMessage').at(-1); };
  f.reply = (text, uid = TARGET) => f.say(ADMIN, text, { reply_to_message: { message_id: 5, from: { id: uid, first_name: 'Tgt' }, chat: { id: CHAT } } });
  return f;
}

test('ban response: premium layout, shows ID/admin/reason/duration, and Undo performs a real unban', async () => {
  const f = await group();
  const sent = await f.reply('/ban spamming links');
  const text = plain(sent.params.text);
  assert.match(text, /USER BANNED/);
  assert.match(text, /User ID:\s*50000/);
  assert.match(text, /Admin:/);
  assert.match(text, /Reason: spamming links/);
  assert.match(text, /Duration: Permanent/);
  assert.ok(sent.params.text.includes('<blockquote>'), 'note in a blockquote');
  assert.ok(balanced(sent.params.text));
  const undo = buttonsOf(sent.params.reply_markup)[0];
  assert.equal(norm(undo.text), '↩️ UNDO BAN');
  assert.equal(f.tg.members.get(`${CHAT}:${TARGET}`).status, 'kicked');
  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(ADMIN, { message_id: 7, chat: { id: CHAT, type: 'supergroup' } }, undo.callback_data) }));
  assert.equal(f.tg.sent('unbanChatMember').length, 1, 'Undo really unbans');
  assert.match(plain(f.tg.last('editMessageText').params.text), /USER UNBANNED/);
  assert.equal(f.tg.members.get(`${CHAT}:${TARGET}`).status, 'left');
});

test('Undo is refused for non-admins and shown only where a reversal exists', async () => {
  const f = await group();
  const banned = await f.reply('/ban x');
  const undo = buttonsOf(banned.params.reply_markup)[0];
  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(TARGET, { message_id: 7, chat: { id: CHAT, type: 'supergroup' } }, undo.callback_data) }));
  assert.equal(f.tg.sent('unbanChatMember').length, 0);
  assert.equal(f.tg.last('answerCallbackQuery').params.show_alert, true);

  const kicked = await f.reply('/kick bye', 50001);
  assert.equal(kicked.params.reply_markup, undefined, 'no Undo for a kick');
  const muted = await f.reply('/tmute 10m noisy', 50002);
  assert.equal(norm(buttonsOf(muted.params.reply_markup)[0].text), '↩️ UNDO MUTE');
  assert.match(plain(muted.params.text), /Duration: 10 minutes/);
});

test('warn response uses the same layout and Undo Warning really removes it', async () => {
  const f = await group();
  const sent = await f.reply('/warn first');
  const text = plain(sent.params.text);
  assert.match(text, /WARNING ISSUED/);
  assert.match(text, /Warnings:\s*1\//);
  const undo = buttonsOf(sent.params.reply_markup)[0];
  assert.equal(norm(undo.text), '↩️ UNDO WARNING');
  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(ADMIN, { message_id: 7, chat: { id: CHAT, type: 'supergroup' } }, undo.callback_data) }));
  assert.match(plain(f.tg.last('editMessageText').params.text), /WARNING REMOVED/);
  assert.equal(await f.db.value('SELECT COUNT(*) FROM group_warnings'), 0);
});

test('failed Telegram action never shows a success panel or Undo', async () => {
  const f = await group();
  const { TelegramError } = await import('../src/utils/errors.js');
  f.tg.failWhen((m) => m === 'banChatMember', new TelegramError('Bad Request: not enough rights', { status: 400, method: 'banChatMember' }));
  const sent = await f.reply('/ban x');
  assert.doesNotMatch(plain(sent.params.text), /USER BANNED/);
  assert.equal(sent.params.reply_markup, undefined);
});

test('/security shows real ON/OFF values and reflects changes; settings toggles are coloured by state', async () => {
  const f = await group();
  let sent = await f.say(ADMIN, '/security');
  assert.match(plain(sent.params.text), /SECURITY OVERVIEW/);
  assert.match(plain(sent.params.text), /Antiflood:\s*🔴 OFF/);
  await f.say(ADMIN, '/antiflood on');
  sent = await f.say(ADMIN, '/security');
  assert.match(plain(sent.params.text), /Antiflood:\s*🟢 ON/);
  await f.say(ADMIN, '/lock url');
  sent = await f.say(ADMIN, '/security');
  assert.match(plain(sent.params.text), /Active locks:\s*1/);
  const m = await f.say(MEMBER_OR(ADMIN), '/settings');
  const flood = buttonsOf(m.params.reply_markup).find((b) => b.callback_data === 'gs:flood');
  assert.ok(flood);
  f.tg.reset();
  await processUpdate(f.ctx, update({ callback_query: callbackQuery(ADMIN, { message_id: 9, chat: { id: CHAT, type: 'supergroup' } }, 'gs:flood') }));
  const toggle = buttonsOf(f.tg.last('editMessageText').params.reply_markup).find((b) => b.callback_data === 'gs:flood:t:flood.on');
  assert.match(plain(toggle.text), /🟢 ON/);
  assert.equal(toggle.style, 'success');
});
const MEMBER_OR = (x) => x;

test('/filters lists trigger, response type, buttons and status', async () => {
  const f = await group();
  await f.say(ADMIN, '/filter hello Hi there\n(Site - https://example.com)');
  const sent = await f.say(ADMIN, '/filters');
  const t = plain(sent.params.text);
  assert.match(t, /FILTERS/);
  assert.match(t, /hello/);
  assert.match(t, /Whole word/);
  assert.match(t, /1 button/);
  assert.match(t, /Active/);
  assert.ok(balanced(sent.params.text));
});

test('help card for a group command, and /help in a group is closable', async () => {
  const f = await group();
  const card = await f.say(ADMIN, '/help ban');
  assert.match(plain(card.params.text), /BAN COMMAND/);
  assert.match(plain(card.params.text), /Group administrators/);
  const menu = await f.say(ADMIN, '/help');
  assert.ok(buttonsOf(menu.params.reply_markup).some((b) => b.callback_data === 'x:close'));
});
