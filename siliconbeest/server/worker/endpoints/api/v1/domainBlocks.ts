import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../types';
import { authRequired } from '../../../middleware/auth';
import { requireScope } from '../../../middleware/scopeCheck';
import { AppError } from '../../../middleware/errorHandler';
import { generateUlid } from '../../../utils/ulid';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

// GET /api/v1/domain_blocks — list user's blocked domains
app.get('/', authRequired, requireScope('read:blocks'), async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const limit = Math.min(parseInt(c.req.query('limit') || '100', 10) || 100, 200);
  const maxId = c.req.query('max_id');

  const conditions = ['account_id = ?1'];
  const binds: (string | number)[] = [currentAccount.id];

  if (maxId) {
    conditions.push('id < ?2');
    binds.push(maxId);
  }

  const { results } = await env.DB.prepare(
    `SELECT id, domain FROM user_domain_blocks
     WHERE ${conditions.join(' AND ')}
     ORDER BY id DESC
     LIMIT ?${binds.length + 1}`,
  )
    .bind(...binds, limit)
    .all();

  const domains = (results ?? []).map((r: any) => r.domain as string);

  return c.json(domains);
});

// POST /api/v1/domain_blocks — block a domain
app.post('/', authRequired, requireScope('write:blocks'), async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const body = await c.req.json<{ domain?: string }>();

  if (!body.domain) throw new AppError(422, 'Validation failed: domain is required');

  const domain = body.domain.toLowerCase().trim();

  const existing = await env.DB.prepare(
    'SELECT id FROM user_domain_blocks WHERE account_id = ?1 AND domain = ?2',
  )
    .bind(currentAccount.id, domain)
    .first();

  let changed = false;
  if (!existing) {
    const id = generateUlid();
    const now = new Date().toISOString();
    const inserted = await env.DB.prepare(
      'INSERT INTO user_domain_blocks (id, account_id, domain, created_at) VALUES (?1, ?2, ?3, ?4)',
    )
      .bind(id, currentAccount.id, domain, now)
      .run();
    changed = (inserted.meta?.changes ?? 0) > 0;
  }

  // A domain block is a relationship boundary, not only a display filter.
  // Tear down both follow directions and derived state in one ordered D1 batch.
  const cleanupResults = await env.DB.batch([
    env.DB.prepare(
      `UPDATE accounts
       SET following_count = MAX(0, following_count - (
         SELECT COUNT(*)
         FROM follows domain_follow
         JOIN accounts remote_account
           ON remote_account.id = domain_follow.target_account_id
         WHERE domain_follow.account_id = ?1
           AND lower(remote_account.domain) = lower(?2)
       ))
       WHERE id = ?1`,
    ).bind(currentAccount.id, domain),
    env.DB.prepare(
      `UPDATE accounts
       SET followers_count = MAX(0, followers_count - 1)
       WHERE id IN (
         SELECT domain_follow.target_account_id
         FROM follows domain_follow
         JOIN accounts remote_account
           ON remote_account.id = domain_follow.target_account_id
         WHERE domain_follow.account_id = ?1
           AND lower(remote_account.domain) = lower(?2)
       )`,
    ).bind(currentAccount.id, domain),
    env.DB.prepare(
      `UPDATE accounts
       SET followers_count = MAX(0, followers_count - (
         SELECT COUNT(*)
         FROM follows domain_follow
         JOIN accounts remote_account
           ON remote_account.id = domain_follow.account_id
         WHERE domain_follow.target_account_id = ?1
           AND lower(remote_account.domain) = lower(?2)
       ))
       WHERE id = ?1`,
    ).bind(currentAccount.id, domain),
    env.DB.prepare(
      `UPDATE accounts
       SET following_count = MAX(0, following_count - 1)
       WHERE id IN (
         SELECT domain_follow.account_id
         FROM follows domain_follow
         JOIN accounts remote_account
           ON remote_account.id = domain_follow.account_id
         WHERE domain_follow.target_account_id = ?1
           AND lower(remote_account.domain) = lower(?2)
       )`,
    ).bind(currentAccount.id, domain),
    env.DB.prepare(
      `DELETE FROM follows
       WHERE (account_id = ?1 AND target_account_id IN (
         SELECT id FROM accounts
         WHERE domain IS NOT NULL AND lower(domain) = lower(?2)
       )) OR (target_account_id = ?1 AND account_id IN (
         SELECT id FROM accounts
         WHERE domain IS NOT NULL AND lower(domain) = lower(?2)
       ))`,
    ).bind(currentAccount.id, domain),
    env.DB.prepare(
      `DELETE FROM follow_requests
       WHERE (account_id = ?1 AND target_account_id IN (
         SELECT id FROM accounts
         WHERE domain IS NOT NULL AND lower(domain) = lower(?2)
       )) OR (target_account_id = ?1 AND account_id IN (
         SELECT id FROM accounts
         WHERE domain IS NOT NULL AND lower(domain) = lower(?2)
       ))`,
    ).bind(currentAccount.id, domain),
    env.DB.prepare(
      `DELETE FROM list_accounts
       WHERE list_id IN (SELECT id FROM lists WHERE account_id = ?1)
         AND account_id IN (
           SELECT id FROM accounts
           WHERE domain IS NOT NULL AND lower(domain) = lower(?2)
         )`,
    ).bind(currentAccount.id, domain),
    env.DB.prepare(
      `DELETE FROM account_pins
       WHERE (account_id = ?1 AND target_account_id IN (
         SELECT id FROM accounts
         WHERE domain IS NOT NULL AND lower(domain) = lower(?2)
       )) OR (target_account_id = ?1 AND account_id IN (
         SELECT id FROM accounts
         WHERE domain IS NOT NULL AND lower(domain) = lower(?2)
       ))`,
    ).bind(currentAccount.id, domain),
  ]);
  changed ||= cleanupResults.slice(4).some((result) => (result.meta?.changes ?? 0) > 0);
  c.set('contributionApplied', changed);

  return c.json({});
});

// DELETE /api/v1/domain_blocks — unblock a domain
app.delete('/', authRequired, requireScope('write:blocks'), async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const body = await c.req.json<{ domain?: string }>();

  if (!body.domain) throw new AppError(422, 'Validation failed: domain is required');

  const domain = body.domain.toLowerCase().trim();

  const result = await env.DB.prepare(
    'DELETE FROM user_domain_blocks WHERE account_id = ?1 AND domain = ?2',
  )
    .bind(currentAccount.id, domain)
    .run();
  c.set('contributionApplied', (result.meta?.changes ?? 0) > 0);

  return c.json({});
});

export default app;
