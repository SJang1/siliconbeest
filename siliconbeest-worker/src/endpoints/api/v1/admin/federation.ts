/**
 * Admin Federation API
 *
 * GET /instances          — List all known instances (paginated, searchable)
 * GET /instances/:domain  — Single instance detail with account count
 * GET /stats              — Federation overview statistics
 *
 * All endpoints require authRequired + adminRequired.
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired, adminRequired } from '../../../../middleware/auth';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

// Apply auth to all routes
app.use('*', authRequired, adminRequired);

// GET /instances — list all instances with pagination and search
app.get('/instances', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '40', 10) || 40, 200);
  const offset = parseInt(c.req.query('offset') ?? '0', 10) || 0;
  const search = c.req.query('search') ?? '';

  let results;
  if (search) {
    const { results: rows } = await c.env.DB.prepare(
      `SELECT i.*, (SELECT COUNT(*) FROM accounts a WHERE a.domain = i.domain) AS account_count
       FROM instances i WHERE i.domain LIKE ?1
       ORDER BY i.updated_at DESC LIMIT ?2 OFFSET ?3`,
    )
      .bind(`%${search}%`, limit, offset)
      .all();
    results = rows;
  } else {
    const { results: rows } = await c.env.DB.prepare(
      `SELECT i.*, (SELECT COUNT(*) FROM accounts a WHERE a.domain = i.domain) AS account_count
       FROM instances i
       ORDER BY i.updated_at DESC LIMIT ?1 OFFSET ?2`,
    )
      .bind(limit, offset)
      .all();
    results = rows;
  }

  return c.json(results ?? []);
});

// GET /instances/:domain — single instance detail
app.get('/instances/:domain', async (c) => {
  const domain = c.req.param('domain');

  const instance = await c.env.DB.prepare(
    `SELECT i.*, (SELECT COUNT(*) FROM accounts a WHERE a.domain = i.domain) AS account_count
     FROM instances i WHERE i.domain = ?`,
  )
    .bind(domain)
    .first();

  if (!instance) {
    return c.json({ error: 'Instance not found' }, 404);
  }

  return c.json(instance);
});

// GET /stats — federation overview
app.get('/stats', async (c) => {
  const totalInstances = await c.env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM instances',
  ).first<{ cnt: number }>();

  const activeInstances = await c.env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM instances
     WHERE last_successful_at IS NOT NULL
     AND (last_failed_at IS NULL OR last_successful_at > last_failed_at)`,
  ).first<{ cnt: number }>();

  const unreachableInstances = await c.env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM instances
     WHERE failure_count > 0
     AND (last_successful_at IS NULL OR last_failed_at > last_successful_at)`,
  ).first<{ cnt: number }>();

  const remoteAccounts = await c.env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM accounts WHERE domain IS NOT NULL',
  ).first<{ cnt: number }>();

  return c.json({
    total_instances: totalInstances?.cnt ?? 0,
    active_instances: activeInstances?.cnt ?? 0,
    unreachable_instances: unreachableInstances?.cnt ?? 0,
    remote_accounts: remoteAccounts?.cnt ?? 0,
  });
});

export default app;
