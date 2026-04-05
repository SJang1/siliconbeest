import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { getRelationships } from '../../../../services/account';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.get('/relationships', authRequired, async (c) => {
  const currentAccountId = c.get('currentUser')!.account_id;
  const db = c.env.DB;

  // Mastodon sends id[]=... or id=...
  const url = new URL(c.req.url);
  const ids = url.searchParams.getAll('id[]');
  if (ids.length === 0) {
    const singleId = url.searchParams.get('id');
    if (singleId) ids.push(singleId);
  }

  if (ids.length === 0) {
    return c.json([]);
  }

  return c.json(await getRelationships(db, currentAccountId, ids));
});

export default app;
