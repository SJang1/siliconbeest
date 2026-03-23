import { Hono } from 'hono';
import type { Env, AppVariables } from '../../env';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get('/:username/following', async (c) => {
  const username = c.req.param('username');
  const domain = c.env.INSTANCE_DOMAIN;

  const account = await c.env.DB.prepare(`
    SELECT id, following_count FROM accounts
    WHERE username = ?1 AND domain IS NULL
    LIMIT 1
  `).bind(username).first<{ id: string; following_count: number }>();

  if (!account) {
    return c.json({ error: 'Record not found' }, 404);
  }

  const actorUri = `https://${domain}/users/${username}`;

  return c.json({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${actorUri}/following`,
    type: 'OrderedCollection',
    totalItems: account.following_count,
  }, 200, {
    'Content-Type': 'application/activity+json; charset=utf-8',
  });
});

export default app;
