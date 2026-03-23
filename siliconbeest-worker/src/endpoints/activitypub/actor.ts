import { Hono } from 'hono';
import type { Env, AppVariables } from '../../env';
import { serializeActor } from '../../federation/actorSerializer';
import type { AccountRow, ActorKeyRow } from '../../types/db';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get('/:username', async (c) => {
  const username = c.req.param('username');
  const domain = c.env.INSTANCE_DOMAIN;

  const account = await c.env.DB.prepare(`
    SELECT * FROM accounts
    WHERE username = ?1 AND domain IS NULL
    LIMIT 1
  `).bind(username).first<AccountRow>();

  if (!account) {
    return c.json({ error: 'Record not found' }, 404);
  }

  const actorKey = await c.env.DB.prepare(`
    SELECT * FROM actor_keys
    WHERE account_id = ?1
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(account.id).first<ActorKeyRow>();

  if (!actorKey) {
    return c.json({ error: 'Actor key not found' }, 500);
  }

  const actor = serializeActor(account, actorKey, domain);

  return c.json(actor, 200, {
    'Content-Type': 'application/activity+json; charset=utf-8',
    'Cache-Control': 'max-age=180, public',
  });
});

export default app;
