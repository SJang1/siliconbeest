import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';

type HonoEnv = { Bindings: Env; Variables: AppVariables };
import { AppError } from '../../../../middleware/errorHandler';
import { sendToRecipient } from '../../../../federation/helpers/send';
import { Block } from '@fedify/fedify/vocab';
import { generateUlid } from '../../../../utils/ulid';

const app = new Hono<HonoEnv>();

app.post('/:id/block', authRequired, async (c) => {
  const targetId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;

  if (currentAccountId === targetId) {
    throw new AppError(422, 'Validation failed', 'You cannot block yourself');
  }

  const target = await c.env.DB.prepare('SELECT id, domain, uri FROM accounts WHERE id = ?1').bind(targetId).first();
  if (!target) throw new AppError(404, 'Record not found');

  const existing = await c.env.DB.prepare(
    'SELECT id FROM blocks WHERE account_id = ?1 AND target_account_id = ?2',
  ).bind(currentAccountId, targetId).first();

  if (!existing) {
    const now = new Date().toISOString();
    const id = generateUlid();

    // Block and remove any existing follows in both directions
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO blocks (id, account_id, target_account_id, created_at) VALUES (?1, ?2, ?3, ?4)',
      ).bind(id, currentAccountId, targetId, now),
      c.env.DB.prepare('DELETE FROM follows WHERE account_id = ?1 AND target_account_id = ?2').bind(currentAccountId, targetId),
      c.env.DB.prepare('DELETE FROM follows WHERE account_id = ?1 AND target_account_id = ?2').bind(targetId, currentAccountId),
      c.env.DB.prepare('DELETE FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2').bind(currentAccountId, targetId),
      c.env.DB.prepare('DELETE FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2').bind(targetId, currentAccountId),
    ]);
  }

  // Federation: deliver Block activity if target is remote
  if (target.domain) {
    try {
      const currentAccount = await c.env.DB.prepare(
        'SELECT uri, username FROM accounts WHERE id = ?1',
      ).bind(currentAccountId).first();
      if (currentAccount) {
        const actorUri = currentAccount.uri as string;
        const targetUri = target.uri as string;
        const domain = c.env.INSTANCE_DOMAIN;
        const block = new Block({
          id: new URL(`https://${domain}/activities/${generateUlid()}`),
          actor: new URL(actorUri),
          object: new URL(targetUri),
        });
        const fed = c.get('federation');
        await sendToRecipient(fed, c.env, currentAccount.username as string, targetUri, block);
      }
    } catch (e) {
      console.error('Federation delivery failed for block:', e);
    }
  }

  return c.json({
    id: targetId,
    following: false,
    showing_reblogs: false,
    notifying: false,
    languages: null,
    followed_by: false,
    blocking: true,
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
