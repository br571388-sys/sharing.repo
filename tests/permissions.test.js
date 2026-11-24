import test from 'node:test';
import assert from 'node:assert/strict';
import { Role, hasAccess, isBotOwner, resolveAuthority, senderOf, visibleAccessLevels } from '../src/core/permissions.js';
import { getGroup, upsertGroup, addGroupAdmin } from '../src/database/groups.js';
import { makeCtx, groupMsg, privateMsg, OWNER } from './helpers/fakes.js';

const GROUP = -100500;

test('isBotOwner only matches the configured OWNER_ID', async () => {
  const { ctx } = await makeCtx();
  assert.equal(isBotOwner(ctx.config, OWNER), true);
  assert.equal(isBotOwner(ctx.config, 5), false);
  assert.equal(isBotOwner(ctx.config, undefined), false);
  assert.equal(isBotOwner({ ownerId: null }, 0), false);
});

test('owner-only commands: owner yes, everyone else no (private and group)', async () => {
  const { ctx } = await makeCtx();
  assert.equal((await hasAccess(ctx, 'owner', privateMsg(OWNER, '/dashboard'))).ok, true);
  assert.equal((await hasAccess(ctx, 'owner', privateMsg(5, '/dashboard'))).ok, false);
  assert.equal((await hasAccess(ctx, 'owner', groupMsg(GROUP, 5, '/dashboard'))).ok, false);
});

test('a user id typed in the message text never grants permission', async () => {
  const { ctx } = await makeCtx();
  const m = privateMsg(5, `/broadcast ${OWNER} hello`);
  assert.equal((await hasAccess(ctx, 'owner', m)).ok, false);
});

test('anonymous admins / channel senders cannot be verified', async () => {
  const { ctx } = await makeCtx();
  const anon = groupMsg(GROUP, 1087968824, '/announce hi');
  assert.equal(senderOf(anon), null);
  assert.equal((await hasAccess(ctx, 'groupAdmin', anon)).ok, false);
  const channel = groupMsg(GROUP, 7, '/announce hi', { sender_chat: { id: -1009, type: 'channel' } });
  assert.equal(senderOf(channel), null);
});

test('group roles come from Telegram member status', async () => {
  const { ctx, tg, db } = await makeCtx();
  tg.setMember(GROUP, 11, 'creator');
  tg.setMember(GROUP, 12, 'administrator');
  tg.setMember(GROUP, 13, 'member');
  const chat = { id: GROUP, type: 'supergroup', title: 'G' };

  const creator = await resolveAuthority(ctx, chat, 11);
  assert.equal(creator.role, Role.GROUP_OWNER);
  assert.equal(creator.canManage, true);
  assert.equal((await getGroup(db, GROUP)).owner_user_id, 11, 'owner synced from Telegram');

  const admin = await resolveAuthority(ctx, chat, 12);
  assert.equal(admin.role, Role.ADMIN);
  assert.equal(admin.canAnnounce, true);
  assert.equal(admin.canManage, false);

  const member = await resolveAuthority(ctx, chat, 13);
  assert.equal(member.canAnnounce, false);
  assert.equal(member.canManage, false);
});

test('an explicitly authorised admin can manage; a demoted one cannot', async () => {
  const { ctx, tg, db } = await makeCtx();
  const chat = { id: GROUP, type: 'supergroup', title: 'G' };
  const { group } = await upsertGroup(db, chat);
  await addGroupAdmin(db, group, 12, 11);
  tg.setMember(GROUP, 12, 'administrator');
  assert.equal((await resolveAuthority(ctx, chat, 12)).role, Role.AUTHORIZED_ADMIN);
  assert.equal((await resolveAuthority(ctx, chat, 12)).canManage, true);
  tg.setMember(GROUP, 12, 'member');
  assert.equal((await resolveAuthority(ctx, chat, 12)).canManage, false);
});

test('a registered (non-creator) owner must still be an administrator', async () => {
  const { ctx, tg, db } = await makeCtx();
  const chat = { id: GROUP, type: 'supergroup', title: 'G' };
  await upsertGroup(db, chat, { ownerUserId: 20, ownerSource: 'registered' });
  tg.setMember(GROUP, 20, 'administrator');
  assert.equal((await resolveAuthority(ctx, chat, 20)).role, Role.GROUP_OWNER);
  tg.setMember(GROUP, 20, 'member');
  assert.equal((await resolveAuthority(ctx, chat, 20)).canManage, false);
});

test('backup access: private chats are owner-only, groups need a group manager', async () => {
  const { ctx, tg } = await makeCtx();
  assert.equal((await hasAccess(ctx, 'backup', privateMsg(OWNER, '/backup'))).ok, true);
  assert.equal((await hasAccess(ctx, 'backup', privateMsg(5, '/backup'))).ok, false);
  tg.setMember(GROUP, 11, 'creator');
  tg.setMember(GROUP, 12, 'administrator');
  assert.equal((await hasAccess(ctx, 'backup', groupMsg(GROUP, 11, '/backup'))).ok, true);
  assert.equal((await hasAccess(ctx, 'backup', groupMsg(GROUP, 12, '/backup'))).ok, false);
});

test('help visibility: normal users never see owner-only commands', async () => {
  const { ctx, tg } = await makeCtx();
  const user = await visibleAccessLevels(ctx, privateMsg(5, '/help'));
  assert.deepEqual([...user], ['public']);
  const owner = await visibleAccessLevels(ctx, privateMsg(OWNER, '/help'));
  assert.ok(owner.has('owner') && owner.has('backup'));
  tg.setMember(GROUP, 12, 'administrator');
  const admin = await visibleAccessLevels(ctx, groupMsg(GROUP, 12, '/help'));
  assert.ok(admin.has('groupAdmin') && !admin.has('owner') && !admin.has('backup'));
});
