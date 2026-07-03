/**
 * Admin Federation API
 *
 * GET /instances          — List all known instances (paginated, searchable)
 * GET /instances/:domain  — Single instance detail with account count
 * GET /stats              — Federation overview statistics
 * GET /dlq                — List parked dead-letter messages
 * POST /dlq/:id/replay    — Re-enqueue a parked message to the federation queue
 * DELETE /dlq/:id         — Discard a parked message
 *
 * All endpoints require authRequired + adminRequired.
 */

import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { authRequired, adminRequired } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';
import {
  listInstances,
  getInstance,
  getFederationStats,
  listDlqParked,
  getDlqParked,
  markDlqParked,
} from '../../../../services/admin';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

// Apply auth to all routes
app.use('*', authRequired, adminRequired);

// GET /instances — list all instances with pagination and search
app.get('/instances', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '40', 10) || 40, 200);
  const offset = parseInt(c.req.query('offset') ?? '0', 10) || 0;
  const search = c.req.query('search') ?? '';

  const results = await listInstances({
    limit,
    offset,
    search: search || undefined,
  });

  return c.json(results);
});

// GET /instances/:domain — single instance detail
app.get('/instances/:domain', async (c) => {
  const domain = c.req.param('domain');

  const instance = await getInstance(domain);

  if (!instance) {
    return c.json({ error: 'Instance not found' }, 404);
  }

  return c.json(instance);
});

// GET /stats — federation overview
app.get('/stats', async (c) => {
  const stats = await getFederationStats();
  return c.json(stats);
});

// GET /dlq — list parked dead-letter messages (status: parked | replayed | discarded)
app.get('/dlq', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '40', 10) || 40, 200);
  const offset = parseInt(c.req.query('offset') ?? '0', 10) || 0;
  const status = c.req.query('status') ?? 'parked';

  const { items, counts } = await listDlqParked({ status, limit, offset });

  return c.json({
    counts,
    items: items.map((row) => {
      let body: unknown = row.body;
      try {
        body = JSON.parse(row.body);
      } catch {
        // keep raw string if the stored body is not valid JSON
      }
      return { ...row, body };
    }),
  });
});

// POST /dlq/:id/replay — re-enqueue a parked message to the federation queue
app.post('/dlq/:id/replay', async (c) => {
  const row = await getDlqParked(c.req.param('id'));
  if (row.status !== 'parked') {
    throw new AppError(409, `Message already ${row.status}`);
  }

  await env.QUEUE_FEDERATION.send(JSON.parse(row.body));
  await markDlqParked(row.id, 'replayed');

  return c.json({ id: row.id, status: 'replayed' });
});

// DELETE /dlq/:id — discard a parked message
app.delete('/dlq/:id', async (c) => {
  const row = await getDlqParked(c.req.param('id'));
  if (row.status !== 'parked') {
    throw new AppError(409, `Message already ${row.status}`);
  }

  await markDlqParked(row.id, 'discarded');

  return c.json({ id: row.id, status: 'discarded' });
});

export default app;
