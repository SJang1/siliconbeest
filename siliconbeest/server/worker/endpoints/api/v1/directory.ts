import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../types';
import { authOptional } from '../../../middleware/auth';
import { serializeAccount } from '../../../utils/mastodonSerializer';
import type { AccountRow } from '../../../types/db';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

// GET /api/v1/directory — profile directory
app.get('/', authOptional, async (c) => {
  const offset = parseInt(c.req.query('offset') || '0', 10) || 0;
  const limit = Math.min(parseInt(c.req.query('limit') || '40', 10) || 40, 80);
  const order = c.req.query('order') === 'new' ? 'new' : 'active';
  const local = c.req.query('local') !== 'false'; // default true

  const conditions = [
    'a.suspended_at IS NULL',
    'a.discoverable = 1',
  ];
  const binds: (string | number)[] = [];

  if (local) {
    conditions.push('a.domain IS NULL');
  }

  const orderClause =
    order === 'new'
      ? 'a.created_at DESC'
      : 'a.last_status_at DESC NULLS LAST';

  const sql = `
    SELECT a.* FROM accounts a
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderClause}
    LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}
  `;
  binds.push(limit, offset);

  const { results } = await env.DB.prepare(sql).bind(...binds).all();

  const accounts = (results ?? []).map((row: any) =>
    serializeAccount(row as AccountRow, { instanceDomain: env.INSTANCE_DOMAIN }),
  );

  return c.json(accounts);
});

export default app;
