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
import { listInstances, getInstance, getFederationStats } from '../../../../services/admin';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

// Apply auth to all routes
app.use('*', authRequired, adminRequired);

// GET /instances — list all instances with pagination and search
app.get('/instances', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '40', 10) || 40, 200);
  const offset = parseInt(c.req.query('offset') ?? '0', 10) || 0;
  const search = c.req.query('search') ?? '';

  const results = await listInstances(c.env.DB, {
    limit,
    offset,
    search: search || undefined,
  });

  return c.json(results);
});

// GET /instances/:domain — single instance detail
app.get('/instances/:domain', async (c) => {
  const domain = c.req.param('domain');

  const instance = await getInstance(c.env.DB, domain);

  if (!instance) {
    return c.json({ error: 'Instance not found' }, 404);
  }

  return c.json(instance);
});

// GET /stats — federation overview
app.get('/stats', async (c) => {
  const stats = await getFederationStats(c.env.DB);
  return c.json(stats);
});

export default app;
