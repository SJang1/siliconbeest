import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';

type HonoEnv = { Bindings: Env; Variables: AppVariables };
import { AppError } from '../../../../middleware/errorHandler';
import { sendToRecipient } from '../../../../federation/helpers/send';
import { Follow } from '@fedify/fedify/vocab';
import { generateUlid } from '../../../../utils/ulid';

const app = new Hono<HonoEnv>();

app.post('/:id/follow', authRequired, requireScope('write:follows'), async (c) => {
  const targetId = c.req.param('id');
  const currentUser = c.get('currentUser')!;
  const currentAccountId = currentUser.account_id;

  if (currentAccountId === targetId) {
    throw new AppError(422, 'Validation failed', 'You cannot follow yourself');
  }

  const target = await c.env.DB.prepare('SELECT id, username, domain, uri, inbox_url, shared_inbox_url, locked, manually_approves_followers FROM accounts WHERE id = ?1').bind(targetId).first();
  if (!target) throw new AppError(404, 'Record not found');

  // Get current account info for AP
  const currentAccount = await c.env.DB.prepare('SELECT id, username, uri FROM accounts WHERE id = ?1').bind(currentAccountId).first();
  const domain = c.env.INSTANCE_DOMAIN;
  const actorUri = currentAccount?.uri as string || `https://${domain}/users/${currentAccount?.username}`;

  // Check existing follow
  const existingFollow = await c.env.DB.prepare(
    'SELECT id FROM follows WHERE account_id = ?1 AND target_account_id = ?2',
  ).bind(currentAccountId, targetId).first();

  if (existingFollow) {
    return c.json({
      id: targetId,
      following: true,
      showing_reblogs: true,
      notifying: false,
      languages: null,
      followed_by: false,
      blocking: false,
      blocked_by: false,
      muting: false,
      muting_notifications: false,
      requested: false,
      requested_by: false,
      domain_blocking: false,
      endorsed: false,
      note: '',
    });
  }

  // Check existing follow request
  const existingRequest = await c.env.DB.prepare(
    'SELECT id FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2',
  ).bind(currentAccountId, targetId).first();

  if (existingRequest) {
    return c.json({
      id: targetId,
      following: false,
      showing_reblogs: true,
      notifying: false,
      languages: null,
      followed_by: false,
      blocking: false,
      blocked_by: false,
      muting: false,
      muting_notifications: false,
      requested: true,
      requested_by: false,
      domain_blocking: false,
      endorsed: false,
      note: '',
    });
  }

  const now = new Date().toISOString();
  const id = generateUlid();
  const targetUri = target.uri as string;
  const isRemote = !!(target.domain);
  const needsApproval = !!(target.locked || target.manually_approves_followers);

  // For REMOTE accounts: always go through follow_requests first.
  // AP spec: we send Follow, then wait for Accept/Reject from the remote.
  // For LOCAL accounts with locked: also use follow_requests.
  if (isRemote || needsApproval) {
    const followActivityId = `https://${domain}/activities/${generateUlid()}`;
    const follow = new Follow({
      id: new URL(followActivityId),
      actor: new URL(actorUri),
      object: new URL(targetUri),
    });

    await c.env.DB.prepare(
      `INSERT INTO follow_requests (id, account_id, target_account_id, uri, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
    ).bind(id, currentAccountId, targetId, followActivityId, now).run();

    // Send Follow activity to remote server
    if (isRemote) {
      try {
        const fed = c.get('federation');
        await sendToRecipient(fed, c.env, currentAccount?.username as string, targetUri, follow);
      } catch (_) { /* don't fail the API response */ }
    } else {
      // Local locked account: create notification for target
      try {
        await c.env.QUEUE_INTERNAL.send({
          type: 'create_notification',
          recipientAccountId: targetId,
          senderAccountId: currentAccountId,
          notificationType: 'follow_request',
        });
      } catch (_) { /* don't fail */ }
    }

    return c.json({
      id: targetId,
      following: false,
      showing_reblogs: true,
      notifying: false,
      languages: null,
      followed_by: false,
      blocking: false,
      blocked_by: false,
      muting: false,
      muting_notifications: false,
      requested: true,
      requested_by: false,
      domain_blocking: false,
      endorsed: false,
      note: '',
    });
  }

  // LOCAL non-locked account: auto-accept immediately
  const followUri = `https://${domain}/activities/${generateUlid()}`;

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO follows (id, account_id, target_account_id, uri, show_reblogs, notify, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 1, 0, ?5, ?5)`,
    ).bind(id, currentAccountId, targetId, followUri, now),
    c.env.DB.prepare('UPDATE accounts SET following_count = following_count + 1 WHERE id = ?1').bind(currentAccountId),
    c.env.DB.prepare('UPDATE accounts SET followers_count = followers_count + 1 WHERE id = ?1').bind(targetId),
  ]);

  // Notification for local auto-accept
  try {
    await c.env.QUEUE_INTERNAL.send({
      type: 'create_notification',
      recipientAccountId: targetId,
      senderAccountId: currentAccountId,
      notificationType: 'follow',
    });
  } catch (_) { /* don't fail */ }

  return c.json({
    id: targetId,
    following: true,
    showing_reblogs: true,
    notifying: false,
    languages: null,
    followed_by: false,
    blocking: false,
    blocked_by: false,
    muting: false,
    muting_notifications: false,
    requested: false,
    requested_by: false,
    domain_blocking: false,
    endorsed: false,
    note: '',
  });
});

export default app;
