import { Hono } from 'hono';
import type { Env, AppVariables } from '../../env';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get('/:username/followers', async (c) => {
  const username = c.req.param('username');
  const domain = c.env.INSTANCE_DOMAIN;

  const account = await c.env.DB.prepare(`
    SELECT id, followers_count FROM accounts
    WHERE username = ?1 AND domain IS NULL
    LIMIT 1
  `).bind(username).first<{ id: string; followers_count: number }>();

  if (!account) {
    return c.json({ error: 'Record not found' }, 404);
  }

  const actorUri = `https://${domain}/users/${username}`;

  // Mastodon convention: return just the totalItems, not the actual list,
  // to protect user privacy. The full list is only available via the API.
  return c.json({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${actorUri}/followers`,
    type: 'OrderedCollection',
    totalItems: account.followers_count,
  }, 200, {
    'Content-Type': 'application/activity+json; charset=utf-8',
  });
});

export default app;
