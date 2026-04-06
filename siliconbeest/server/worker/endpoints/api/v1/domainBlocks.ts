import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../types';
import { authRequired } from '../../../middleware/auth';
import { AppError } from '../../../middleware/errorHandler';
import { generateUlid } from '../../../utils/ulid';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

// GET /api/v1/domain_blocks — list user's blocked domains
app.get('/', authRequired, async (c) => {
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
app.post('/', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const body = await c.req.json<{ domain?: string }>();

  if (!body.domain) throw new AppError(422, 'Validation failed: domain is required');

  const domain = body.domain.toLowerCase().trim();

  const existing = await env.DB.prepare(
    'SELECT id FROM user_domain_blocks WHERE account_id = ?1 AND domain = ?2',
  )
    .bind(currentAccount.id, domain)
    .first();

  if (!existing) {
    const id = generateUlid();
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO user_domain_blocks (id, account_id, domain, created_at) VALUES (?1, ?2, ?3, ?4)',
    )
      .bind(id, currentAccount.id, domain, now)
      .run();
  }

  return c.json({});
});

// DELETE /api/v1/domain_blocks — unblock a domain
app.delete('/', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const body = await c.req.json<{ domain?: string }>();

  if (!body.domain) throw new AppError(422, 'Validation failed: domain is required');

  const domain = body.domain.toLowerCase().trim();

  await env.DB.prepare(
    'DELETE FROM user_domain_blocks WHERE account_id = ?1 AND domain = ?2',
  )
    .bind(currentAccount.id, domain)
    .run();

  return c.json({});
});

export default app;
