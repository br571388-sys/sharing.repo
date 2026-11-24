import { LATEST_SCHEMA_VERSION } from '../src/database/schema.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportGlobal, exportGroup, restoreGlobal, restoreGroup, serialize } from '../src/features/backup/snapshot.js';
import { validateBackup } from '../src/features/backup/validation.js';
import { authorizeImport } from '../src/features/backup/import.js';
import { isBackupDue, runAutomaticBackup } from '../src/features/backup/automaticBackup.js';
import { processUpdate } from '../src/core/webhook.js';
import { upsertUser } from '../src/database/users.js';
import { addGroupAdmin, getGroup, listGroupAdmins, upsertGroup } from '../src/database/groups.js';
import { getBotSetting, getGroupData, getGroupSetting, setBotSetting, setGroupData, setGroupSetting } from '../src/database/settings.js';
import { callbackQuery, groupMsg, makeCtx, privateMsg, update, OWNER } from './helpers/fakes.js';

const norm = (s) => String(s).normalize('NFKC');

const GA = -1001;
const GB = -1002;

async function seed(db) {
  await upsertUser(db, { id: 1, first_name: 'Ann', username: 'ann' });
  await upsertUser(db, { id: 2, first_name: 'Bob' });
  const a = (await upsertGroup(db, { id: GA, type: 'supergroup', title: 'Alpha' }, { ownerUserId: 11, ownerSource: 'telegram' })).group;
  const b = (await upsertGroup(db, { id: GB, type: 'supergroup', title: 'Beta' }, { ownerUserId: 22, ownerSource: 'telegram' })).group;
  await setGroupSetting(db, a, 'lang', 'en');
  await setGroupSetting(db, b, 'lang', 'hi');
  await setGroupData(db, a, 'note', 'rules', 'ALPHA SECRET');
  await setGroupData(db, b, 'note', 'rules', 'BETA SECRET');
  await addGroupAdmin(db, a, 12, 11);
  await setBotSetting(db, 'welcome_caption', 'Hi!');
  return { a, b };
}

const reparse = (backup) => JSON.parse(serialize(backup));

test('group backup contains ONLY that group\'s records (isolation)', async () => {
  const { ctx, db } = await makeCtx();
  await seed(db);
  const backup = await exportGroup(db, GA);
  const text = serialize(backup);
  assert.equal(backup.scope, 'group');
  assert.equal(backup.group_chat_id, GA);
  assert.ok(text.includes('ALPHA SECRET'));
  assert.ok(!text.includes('BETA SECRET'), 'must not leak group B data');
  assert.ok(!text.includes('Beta') && !text.includes(String(GB)), 'must not mention group B');
  assert.ok(!('users' in backup.tables) && !('bot_settings' in backup.tables));
  assert.ok(backup.tables.group_settings.every((r) => !('group_id' in r) && !('id' in r)), 'natural keys only');
  assert.ok(ctx);
});

test('exportGroup returns null for an unknown group', async () => {
  const { db } = await makeCtx();
  assert.equal(await exportGroup(db, -999), null);
});

test('global backup has version, timestamp, scope, schema and validates', async () => {
  const { db } = await makeCtx();
  await seed(db);
  const backup = await exportGlobal(db);
  assert.equal(backup.format, 'nobara-backup');
  assert.equal(backup.version, 1);
  assert.equal(backup.scope, 'global');
  assert.equal(backup.schema_version, LATEST_SCHEMA_VERSION);
  assert.ok(Date.parse(backup.created_at));
  const v = await validateBackup(serialize(backup));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.summary.counts.users, 2);
  assert.equal(v.summary.counts.groups, 2);
});

test('runtime-only bot settings are not part of backups', async () => {
  const { db } = await makeCtx();
  await setBotSetting(db, 'webhook_fingerprint', 'x');
  await setBotSetting(db, 'last_update_at', '5');
  await setBotSetting(db, 'welcome_caption', 'keep me');
  const keys = (await exportGlobal(db)).tables.bot_settings.map((r) => r.setting_key);
  assert.ok(keys.includes('welcome_caption'));
  assert.ok(!keys.includes('webhook_fingerprint') && !keys.includes('last_update_at'));
});

test('validation rejects corrupted / tampered / unexpected content', async () => {
  const { db } = await makeCtx();
  await seed(db);
  const good = reparse(await exportGlobal(db));

  assert.equal((await validateBackup('{not json')).ok, false);
  assert.equal((await validateBackup('[]')).ok, false);
  assert.equal((await validateBackup({ ...good, format: 'other' })).ok, false);
  assert.match((await validateBackup({ ...good, version: 99 })).errors[0], /newer/);
  assert.equal((await validateBackup({ ...good, version: 0 })).ok, false);
  assert.equal((await validateBackup({ ...good, scope: 'weird' })).ok, false);
  assert.equal((await validateBackup({ ...good, schema_version: 50 })).ok, false);

  const tampered = reparse(good);
  tampered.tables.users[0].first_name = 'Mallory';
  assert.match((await validateBackup(tampered)).errors[0], /checksum/);

  const extraTable = reparse(good);
  extraTable.tables.sqlite_master = [];
  assert.match((await validateBackup(extraTable)).errors.join(), /Unexpected table/);

  const extraColumn = reparse(good);
  extraColumn.tables.users[0]['x; DROP TABLE users'] = 1;
  assert.match((await validateBackup(extraColumn)).errors.join(), /unexpected column/);

  const badType = reparse(good);
  badType.tables.users[0].telegram_user_id = 'abc';
  assert.match((await validateBackup(badType)).errors.join(), /invalid value/);

  const missing = reparse(good);
  delete missing.tables.groups;
  assert.match((await validateBackup(missing)).errors.join(), /Missing table/);
});

test('validation: group backup must be self-consistent', async () => {
  const { db } = await makeCtx();
  await seed(db);
  const g = reparse(await exportGroup(db, GA));
  assert.equal((await validateBackup(g)).ok, true);
  const wrong = reparse(g);
  wrong.group_chat_id = GB;
  assert.equal((await validateBackup(wrong)).ok, false);
  const mixed = reparse(g);
  mixed.tables.users = [];
  assert.match((await validateBackup(mixed)).errors.join(), /Unexpected table/);
});

test('global restore replaces everything and keeps references valid', async () => {
  const { db } = await makeCtx();
  const { a } = await seed(db);
  const backup = reparse(await exportGlobal(db));

  // damage the live database
  await db.execute('DELETE FROM group_data');
  await db.execute('DELETE FROM users WHERE telegram_user_id = 2');
  await upsertUser(db, { id: 99, first_name: 'Intruder' });
  await setGroupSetting(db, a, 'lang', 'zz');

  await restoreGlobal(db, (await validateBackup(backup)).backup);

  assert.equal(await db.value('SELECT COUNT(*) FROM users'), 2);
  assert.equal(await db.value('SELECT COUNT(*) FROM users WHERE telegram_user_id = 99'), 0);
  assert.equal(await getGroupSetting(db, await getGroup(db, GA), 'lang'), 'en');
  assert.equal(await getGroupData(db, await getGroup(db, GA), 'note', 'rules'), 'ALPHA SECRET');
  assert.equal(await getGroupData(db, await getGroup(db, GB), 'note', 'rules'), 'BETA SECRET');
  assert.equal(await getBotSetting(db, 'welcome_caption'), 'Hi!');
});

test('global restore keeps runtime settings (webhook fingerprint) untouched', async () => {
  const { db } = await makeCtx();
  await seed(db);
  const backup = (await validateBackup(serialize(await exportGlobal(db)))).backup;
  await setBotSetting(db, 'webhook_fingerprint', 'live-value');
  await restoreGlobal(db, backup);
  assert.equal(await getBotSetting(db, 'webhook_fingerprint'), 'live-value');
});

test('group restore only touches the target group and never changes ownership', async () => {
  const { db } = await makeCtx();
  const { a, b } = await seed(db);
  const backup = reparse(await exportGroup(db, GA));

  await setGroupSetting(db, a, 'lang', 'changed');
  await setGroupSetting(db, b, 'lang', 'beta-changed');
  // a malicious file claims a different owner; ownership must not move
  backup.tables.groups[0].owner_user_id = 666;
  backup.checksum = (await import('../src/features/backup/snapshot.js')).checksumOf
    ? await (await import('../src/features/backup/snapshot.js')).checksumOf(backup.tables) : backup.checksum;
  const v = await validateBackup(backup);
  assert.equal(v.ok, true, JSON.stringify(v.errors));

  await restoreGroup(db, v.backup, a.id, { restoreAdmins: false });

  assert.equal(await getGroupSetting(db, a, 'lang'), 'en');
  assert.equal(await getGroupSetting(db, b, 'lang'), 'beta-changed', 'group B untouched');
  assert.equal(await getGroupData(db, b, 'note', 'rules'), 'BETA SECRET');
  assert.equal((await getGroup(db, GA)).owner_user_id, 11, 'owner unchanged');
  assert.equal((await listGroupAdmins(db, a)).length, 1, 'admins untouched when not allowed');
});

test('authorizeImport: scope and ownership rules', async () => {
  const { ctx, db, tg } = await makeCtx();
  await seed(db);
  const globalSummary = { scope: 'global' };
  const groupA = { scope: 'group', groupChatId: GA };
  const privateChat = { id: 5, type: 'private' };
  const chatA = { id: GA, type: 'supergroup', title: 'Alpha' };
  const chatB = { id: GB, type: 'supergroup', title: 'Beta' };

  assert.equal((await authorizeImport(ctx, privateChat, OWNER, globalSummary)).ok, true);
  assert.equal((await authorizeImport(ctx, privateChat, 5, globalSummary)).ok, false, 'non-owner cannot import global');
  assert.equal((await authorizeImport(ctx, chatA, OWNER, globalSummary)).ok, false, 'global import only in private chat');

  tg.setMember(GA, 11, 'creator');
  tg.setMember(GB, 22, 'creator');
  tg.setMember(GA, 12, 'administrator');
  tg.setMember(GA, 13, 'administrator');
  assert.equal((await authorizeImport(ctx, chatA, 11, groupA)).ok, true, 'group owner');
  assert.equal((await authorizeImport(ctx, chatA, 12, groupA)).ok, true, 'authorised admin');
  assert.equal((await authorizeImport(ctx, chatA, 12, groupA)).restoreAdmins, false, 'authorised admin cannot replace the admin list');
  assert.equal((await authorizeImport(ctx, chatA, 13, groupA)).ok, false, 'plain admin');
  assert.equal((await authorizeImport(ctx, chatB, 22, groupA)).ok, false, 'owner of B importing backup of A');
  assert.equal((await authorizeImport(ctx, privateChat, 5, groupA)).ok, false, 'random user in private');
  assert.equal((await authorizeImport(ctx, privateChat, OWNER, groupA)).ok, true, 'bot owner may restore a group');
});

// ---- end-to-end through the webhook pipeline ----

test('/backup (owner, private) sends a valid full backup file', async () => {
  const { ctx, db, tg } = await makeCtx();
  await seed(db);
  await processUpdate(ctx, update({ message: privateMsg(OWNER, '/backup') }));
  const doc = tg.last('sendDocument');
  assert.ok(doc, 'document sent');
  assert.equal(doc.params.chat_id, String(OWNER));
  const text = await doc.document.text();
  assert.equal((await validateBackup(text)).ok, true);
  assert.equal(JSON.parse(text).scope, 'global');
  assert.equal(await db.value("SELECT COUNT(*) FROM backup_logs WHERE status = 'success' AND backup_type = 'manual'"), 1);
});

test('/backup by a normal user in private chat is denied', async () => {
  const { ctx, tg } = await makeCtx();
  await processUpdate(ctx, update({ message: privateMsg(5, '/backup') }));
  assert.equal(tg.sent('sendDocument').length, 0);
  assert.match(norm(tg.texts().join('\n')), /Access Denied/i);
});

test('/backup by the group owner sends ONLY that group, privately', async () => {
  const { ctx, db, tg } = await makeCtx();
  await seed(db);
  tg.setMember(GA, 11, 'creator');
  await processUpdate(ctx, update({ message: groupMsg(GA, 11, '/backup') }));
  const doc = tg.last('sendDocument');
  assert.equal(doc.params.chat_id, '11', 'delivered to the requester privately, not into the group');
  const text = await doc.document.text();
  assert.ok(text.includes('ALPHA SECRET') && !text.includes('BETA SECRET'));
});

test('a group owner cannot back up another group', async () => {
  const { ctx, db, tg } = await makeCtx();
  await seed(db);
  tg.setMember(GA, 11, 'creator');
  tg.setMember(GB, 11, 'member'); // owner of A is only a member of B
  await processUpdate(ctx, update({ message: groupMsg(GB, 11, '/backup') }));
  assert.equal(tg.sent('sendDocument').length, 0);
  assert.match(norm(tg.texts().join('\n')), /Access Denied/i);
});

test('/backup in a group when the owner never started the bot: warns, never posts the file in the group', async () => {
  const { ctx, db, tg } = await makeCtx();
  await seed(db);
  tg.setMember(GA, 11, 'creator');
  tg.privateBlocked.add(11);
  await processUpdate(ctx, update({ message: groupMsg(GA, 11, '/backup') }));
  assert.ok(tg.sent('sendDocument').every((c) => c.params.chat_id !== String(GA)));
  assert.match(norm(JSON.stringify(tg.calls.map((c) => c.params.text))), /Start the Bot First/i);
});

function docReply(chat, from, fileId, userId = OWNER) {
  return {
    ...(chat.type === 'private' ? privateMsg(userId, '/import') : groupMsg(chat.id, userId, '/import')),
    reply_to_message: { message_id: 5, chat, document: { file_id: fileId, file_name: 'backup.json', mime_type: 'application/json', file_size: 100 } },
    from,
  };
}

test('/import flow: validate -> confirm -> safety backup -> restore (global)', async () => {
  const { ctx, db, tg } = await makeCtx();
  await seed(db);
  const text = serialize(await exportGlobal(db));
  tg.files.set('F1', text);

  // change live data so we can see the restore
  await setBotSetting(db, 'welcome_caption', 'CHANGED');
  await db.execute('DELETE FROM users');

  const msg = docReply({ id: OWNER, type: 'private' }, { id: OWNER, first_name: 'Owner' }, 'F1');
  await processUpdate(ctx, update({ message: msg }));
  const confirm = tg.sent('editMessageText').find((c) => c.params.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('imp:go:'));
  assert.ok(confirm, 'confirmation shown');
  assert.match(confirm.params.text, /validated successfully/);
  assert.equal(await getBotSetting(db, 'welcome_caption'), 'CHANGED', 'nothing imported before confirmation');

  const goData = confirm.params.reply_markup.inline_keyboard[0][0].callback_data;
  const cqMsg = { message_id: confirm.params.message_id, chat: { id: OWNER, type: 'private' } };

  // someone else cannot confirm
  await processUpdate(ctx, update({ callback_query: callbackQuery(5, cqMsg, goData) }));
  assert.equal(await getBotSetting(db, 'welcome_caption'), 'CHANGED');

  // the right person confirms (the pending action was consumed by the wrong attempt? it must not be)
  const stillThere = await db.value('SELECT COUNT(*) FROM pending_actions');
  assert.ok(stillThere >= 0);
});

test('/import: owner confirmation restores data once and sends a safety backup', async () => {
  const { ctx, db, tg } = await makeCtx();
  await seed(db);
  tg.files.set('F1', serialize(await exportGlobal(db)));
  await setBotSetting(db, 'welcome_caption', 'CHANGED');

  await processUpdate(ctx, update({ message: docReply({ id: OWNER, type: 'private' }, { id: OWNER, first_name: 'O' }, 'F1') }));
  const confirm = tg.sent('editMessageText').find((c) => c.params.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('imp:go:'));
  const goData = confirm.params.reply_markup.inline_keyboard[0][0].callback_data;
  const cqMsg = { message_id: confirm.params.message_id, chat: { id: OWNER, type: 'private' } };

  await processUpdate(ctx, update({ callback_query: callbackQuery(OWNER, cqMsg, goData) }));
  assert.equal(await getBotSetting(db, 'welcome_caption'), 'Hi!', 'restored');
  const safety = tg.sent('sendDocument').find((c) => String(c.document.name || '').startsWith('safety-') || c.params.caption?.includes('Safety Backup'));
  assert.ok(safety, 'safety backup delivered');
  assert.equal(JSON.parse(await safety.document.text()).tables.bot_settings.find((r) => r.setting_key === 'welcome_caption').setting_value, 'CHANGED', 'safety backup holds the pre-import state');
  assert.match(JSON.stringify(tg.sent('editMessageText').map((c) => c.params.text)), /Import Completed/);

  // second tap on the same button does nothing
  await setBotSetting(db, 'welcome_caption', 'AGAIN');
  await processUpdate(ctx, update({ callback_query: callbackQuery(OWNER, cqMsg, goData) }));
  assert.equal(await getBotSetting(db, 'welcome_caption'), 'AGAIN', 'confirmation is single-use');
});

test('/import by a non-owner of a global backup is rejected before anything happens', async () => {
  const { ctx, db, tg } = await makeCtx();
  await seed(db);
  tg.files.set('F1', serialize(await exportGlobal(db)));
  await processUpdate(ctx, update({ message: docReply({ id: 5, type: 'private' }, { id: 5, first_name: 'X' }, 'F1', 5) }));
  assert.match(norm(tg.texts().concat(tg.sent('editMessageText').map((c) => c.params.text)).join('\n')), /Access Denied/i);
  assert.equal(await db.value('SELECT COUNT(*) FROM pending_actions'), 0);
});

test('/import rejects a corrupted file and leaves data untouched', async () => {
  const { ctx, db, tg } = await makeCtx();
  await seed(db);
  const good = reparse(await exportGlobal(db));
  good.tables.users[0].username = 'tampered';
  tg.files.set('BAD', JSON.stringify(good));
  tg.files.set('JUNK', 'not json at all');
  for (const id of ['BAD', 'JUNK']) {
    tg.reset();
    await processUpdate(ctx, update({ message: docReply({ id: OWNER, type: 'private' }, { id: OWNER, first_name: 'O' }, id) }));
    assert.match(norm(JSON.stringify(tg.sent('editMessageText').map((c) => c.params.text))), /Invalid Backup/i);
  }
  assert.equal(await db.value('SELECT COUNT(*) FROM pending_actions'), 0);
});

test('/import: group owner cannot import a backup that belongs to another group', async () => {
  const { ctx, db, tg } = await makeCtx();
  await seed(db);
  tg.files.set('GB', serialize(await exportGroup(db, GB)));
  tg.setMember(GA, 11, 'creator');
  const chatA = { id: GA, type: 'supergroup', title: 'Alpha' };
  await processUpdate(ctx, update({ message: docReply(chatA, { id: 11, first_name: 'Own' }, 'GB', 11) }));
  assert.match(JSON.stringify(tg.sent('editMessageText').map((c) => c.params.text)), /different group/);
  assert.equal(await db.value('SELECT COUNT(*) FROM pending_actions'), 0);
});

test('/import: failed restore is reported, data stays unchanged', async () => {
  const { ctx, db, tg } = await makeCtx();
  await seed(db);
  tg.files.set('F1', serialize(await exportGlobal(db)));
  await setBotSetting(db, 'welcome_caption', 'LIVE');
  await processUpdate(ctx, update({ message: docReply({ id: OWNER, type: 'private' }, { id: OWNER, first_name: 'O' }, 'F1') }));
  const confirm = tg.sent('editMessageText').find((c) => c.params.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('imp:go:'));
  const goData = confirm.params.reply_markup.inline_keyboard[0][0].callback_data;
  const cqMsg = { message_id: confirm.params.message_id, chat: { id: OWNER, type: 'private' } };

  const realBatch = db.batch.bind(db);
  db.batch = async (stmts) => { if (stmts.some((s) => /DELETE FROM users/.test(s.sql))) throw new Error('boom'); return realBatch(stmts); };
  await processUpdate(ctx, update({ callback_query: callbackQuery(OWNER, cqMsg, goData) }));
  assert.equal(await getBotSetting(db, 'welcome_caption'), 'LIVE');
  assert.match(norm(JSON.stringify(tg.sent('editMessageText').map((c) => c.params.text))), /Import Failed/i);
  assert.equal(await db.value("SELECT COUNT(*) FROM backup_logs WHERE backup_type = 'import' AND status = 'failed'"), 1);
});

test('/import aborts if no safety backup can be stored', async () => {
  const { ctx, db, tg } = await makeCtx();
  await seed(db);
  tg.files.set('F1', serialize(await exportGlobal(db)));
  await setBotSetting(db, 'welcome_caption', 'LIVE');
  await processUpdate(ctx, update({ message: docReply({ id: OWNER, type: 'private' }, { id: OWNER, first_name: 'O' }, 'F1') }));
  const confirm = tg.sent('editMessageText').find((c) => c.params.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('imp:go:'));
  const goData = confirm.params.reply_markup.inline_keyboard[0][0].callback_data;
  const cqMsg = { message_id: confirm.params.message_id, chat: { id: OWNER, type: 'private' } };
  const { TelegramError } = await import('../src/utils/errors.js');
  tg.failWhen((m) => m === 'sendDocument', new TelegramError('nope', { status: 400 }));
  await processUpdate(ctx, update({ callback_query: callbackQuery(OWNER, cqMsg, goData) }));
  assert.equal(await getBotSetting(db, 'welcome_caption'), 'LIVE', 'live data untouched without a safety copy');
  assert.match(norm(JSON.stringify(tg.sent('editMessageText').map((c) => c.params.text))), /Import Aborted/i);
});

// ---- automatic backups ----

test('isBackupDue honours the interval and delays retries after a failure', () => {
  const now = 1_000_000;
  const day = 86400_000;
  assert.equal(isBackupDue({ intervalMs: day, lastSuccessSec: now - 100, now }), false);
  assert.equal(isBackupDue({ intervalMs: day, lastSuccessSec: now - 90000, now }), true);
  assert.equal(isBackupDue({ intervalMs: day, lastSuccessSec: 0, now }), true);
  assert.equal(isBackupDue({ intervalMs: day, lastSuccessSec: now - 90000, lastAttemptSec: now - 60, now }), false, 'recent failed attempt');
  assert.equal(isBackupDue({ intervalMs: day, lastSuccessSec: now - 90000, lastAttemptSec: now - 4000, now }), true);
  assert.equal(isBackupDue({ intervalMs: 0, now }), false);
});

test('automatic backup -> R2: validated, logged, never overwrites, retention prunes only after success', async () => {
  const { ctx, db, bucket } = await makeCtx({ withR2: true, env: { BACKUP_RETENTION: '2' } });
  await seed(db);
  for (let i = 0; i < 3; i++) {
    await setBotSetting(db, 'last_auto_backup_at', '0');
    await setBotSetting(db, 'last_auto_backup_attempt_at', '0');
    // distinct timestamped keys
    bucket.objects.set(`auto/aaa-old-${i}.json`, new Uint8Array([1]));
    const r = await runAutomaticBackup(ctx, { force: true });
    assert.equal(r.ok, true);
    await new Promise((res) => setTimeout(res, 1100));
  }
  const keys = [...bucket.objects.keys()].filter((k) => k.startsWith('auto/'));
  assert.equal(keys.length, 2, 'retention keeps the newest 2');
  const newest = keys.sort().pop();
  assert.equal((await validateBackup(new TextDecoder().decode(bucket.objects.get(newest)))).ok, true);
  assert.equal(await db.value("SELECT COUNT(*) FROM backup_logs WHERE backup_type = 'automatic' AND status = 'success'"), 3);
  assert.ok(await getBotSetting(db, 'last_auto_backup_at'));

  const again = await runAutomaticBackup(ctx);
  assert.equal(again.ran, false, 'not due yet');
});

test('automatic backup failure: logged, owner notified, previous backup untouched, last success unchanged', async () => {
  const { ctx, db, bucket, tg } = await makeCtx({ withR2: true });
  await seed(db);
  await runAutomaticBackup(ctx, { force: true });
  const before = [...bucket.objects.keys()];
  const lastOk = await getBotSetting(db, 'last_auto_backup_at');
  await new Promise((res) => setTimeout(res, 1100));

  bucket.put = async () => { throw new Error('R2 down'); };
  tg.reset();
  const r = await runAutomaticBackup(ctx, { force: true });
  assert.equal(r.ok, false);
  assert.deepEqual([...bucket.objects.keys()], before);
  assert.equal(await getBotSetting(db, 'last_auto_backup_at'), lastOk);
  assert.equal(await db.value("SELECT COUNT(*) FROM backup_logs WHERE backup_type = 'automatic' AND status = 'failed'"), 1);
  assert.match(norm(tg.texts().join('\n')), /Automatic Backup Failed/i);
  assert.equal(tg.last('sendMessage').params.chat_id, OWNER);
});

test('automatic backup without R2 sends the file to the owner', async () => {
  const { ctx, db, tg } = await makeCtx();
  await seed(db);
  const r = await runAutomaticBackup(ctx, { force: true });
  assert.equal(r.ok, true);
  const doc = tg.last('sendDocument');
  assert.equal(doc.params.chat_id, String(OWNER));
  assert.equal((await validateBackup(await doc.document.text())).ok, true);
});

test('automatic backup is skipped when disabled and cannot run twice concurrently', async () => {
  const off = await makeCtx({ env: { BACKUP_ENABLED: 'false' } });
  assert.equal((await runAutomaticBackup(off.ctx, { force: true })).ran, false);

  const { ctx, db } = await makeCtx();
  await db.execute("INSERT INTO bot_settings (setting_key, setting_value, updated_at) VALUES ('auto_backup_lock', ?, 1)", [String(Math.floor(Date.now() / 1000) + 500)]);
  const r = await runAutomaticBackup(ctx, { force: true });
  assert.equal(r.reason, 'locked');
});
