import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../env';
import { authRequired } from '../../../middleware/auth';
import { serializeAccount } from '../../../utils/mastodonSerializer';
import type { AccountRow } from '../../../types/db';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

// GET /api/v1/suggestions — follow suggestions
// Returns recently active local accounts the user is not already following
app.get('/', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;

  const limit = Math.min(
    parseInt(c.req.query('limit') || '40', 10) || 40,
    80,
  );

  const { results } = await c.env.DB.prepare(
    `SELECT a.*
     FROM accounts a
     WHERE a.domain IS NULL
       AND a.suspended_at IS NULL
       AND a.id != ?1
       AND a.discoverable = 1
       AND a.id NOT IN (
         SELECT target_account_id FROM follows WHERE account_id = ?1
       )
       AND a.id NOT IN (
         SELECT target_account_id FROM blocks WHERE account_id = ?1
       )
     ORDER BY a.last_status_at DESC NULLS LAST
     LIMIT ?2`,
  )
    .bind(currentAccount.id, limit)
    .all();

  const suggestions = (results ?? []).map((row: any) => ({
    source: 'staff' as const,
    account: serializeAccount(row as AccountRow),
  }));

  return c.json(suggestions);
});

export default app;
