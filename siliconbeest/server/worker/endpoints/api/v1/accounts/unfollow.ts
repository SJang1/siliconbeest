import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';
import { sendToRecipient } from '../../../../federation/helpers/send';
import { Follow, Undo } from '@fedify/fedify/vocab';
import { generateUlid } from '../../../../utils/ulid';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.post('/:id/unfollow', authRequired, requireScope('write:follows'), async (c) => {
  const targetId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;
  const domain = c.env.INSTANCE_DOMAIN;

  const target = await c.env.DB.prepare('SELECT id, username, domain, uri, inbox_url, shared_inbox_url FROM accounts WHERE id = ?1').bind(targetId).first();
  if (!target) throw new AppError(404, 'Record not found');

  const currentAccount = await c.env.DB.prepare('SELECT id, username, uri FROM accounts WHERE id = ?1').bind(currentAccountId).first();
  const actorUri = currentAccount?.uri as string || `https://${domain}/users/${currentAccount?.username}`;
  const targetUri = target.uri as string;

  // Remove follow
  const follow = await c.env.DB.prepare(
    'SELECT id, uri FROM follows WHERE account_id = ?1 AND target_account_id = ?2',
  ).bind(currentAccountId, targetId).first();

  if (follow) {
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM follows WHERE id = ?1').bind(follow.id as string),
      c.env.DB.prepare('UPDATE accounts SET following_count = MAX(0, following_count - 1) WHERE id = ?1').bind(currentAccountId),
      c.env.DB.prepare('UPDATE accounts SET followers_count = MAX(0, followers_count - 1) WHERE id = ?1').bind(targetId),
    ]);

    // Send Undo(Follow) to remote server
    if (target.domain) {
      try {
        const originalFollow = new Follow({
          id: new URL((follow.uri as string) || `https://${domain}/activities/${generateUlid()}`),
          actor: new URL(actorUri),
          object: new URL(targetUri),
        });
        const undo = new Undo({
          id: new URL(`https://${domain}/activities/${generateUlid()}`),
          actor: new URL(actorUri),
          object: originalFollow,
        });
        const fed = c.get('federation');
        await sendToRecipient(fed, c.env, currentAccount?.username as string, targetUri, undo);
      } catch (_) { /* don't fail the API response */ }
    }
  }

  // Also remove any pending follow request
  const fr = await c.env.DB.prepare(
    'SELECT id, uri FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2',
  ).bind(currentAccountId, targetId).first();

  if (fr) {
    await c.env.DB.prepare(
      'DELETE FROM follow_requests WHERE id = ?1',
    ).bind(fr.id as string).run();

    // Send Undo(Follow) for pending request too
    if (target.domain) {
      try {
        const frFollow = new Follow({
          id: new URL((fr.uri as string) || `https://${domain}/activities/${generateUlid()}`),
          actor: new URL(actorUri),
          object: new URL(targetUri),
        });
        const undo = new Undo({
          id: new URL(`https://${domain}/activities/${generateUlid()}`),
          actor: new URL(actorUri),
          object: frFollow,
        });
        const fed = c.get('federation');
        await sendToRecipient(fed, c.env, currentAccount?.username as string, targetUri, undo);
      } catch (_) { /* don't fail */ }
    }
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
    requested: false,
    requested_by: false,
    domain_blocking: false,
    endorsed: false,
    note: '',
  });
});

export default app;
