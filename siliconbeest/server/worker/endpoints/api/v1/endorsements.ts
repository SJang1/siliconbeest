import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../types';
import { authRequired } from '../../../middleware/auth';
import { serializeAccount } from '../../../utils/mastodonSerializer';
import type { AccountRow } from '../../../types/db';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

// GET /api/v1/endorsements — list endorsed/featured accounts
app.get('/', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const limit = Math.min(parseInt(c.req.query('limit') || '40', 10) || 40, 80);

  const { results } = await env.DB.prepare(
    `SELECT a.* FROM account_pins ap
     JOIN accounts a ON a.id = ap.target_account_id
     WHERE ap.account_id = ?1
     ORDER BY ap.created_at DESC
     LIMIT ?2`,
  )
    .bind(currentAccount.id, limit)
    .all();

  const accounts = (results ?? []).map((row: any) =>
    serializeAccount(row as AccountRow, { instanceDomain: env.INSTANCE_DOMAIN }),
  );

  return c.json(accounts);
});

export default app;
