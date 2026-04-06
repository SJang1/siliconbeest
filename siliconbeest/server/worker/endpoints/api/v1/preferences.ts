import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../types';
import { authRequired } from '../../../middleware/auth';

const app = new Hono<{ Variables: AppVariables }>();

app.get('/', authRequired, async (c) => {
  const user = c.get('currentUser')!;

  const { results } = await env.DB.prepare(
    `SELECT key, value FROM user_preferences WHERE user_id = ?1`,
  ).bind(user.id).all();

  const prefs: Record<string, any> = {
    'posting:default:visibility': 'public',
    'posting:default:sensitive': false,
    'posting:default:language': null,
    'reading:expand:media': 'default',
    'reading:expand:spoilers': false,
  };

  for (const row of results ?? []) {
    const key = row.key as string;
    const value = row.value as string;
    if (key in prefs) {
      if (value === 'true') prefs[key] = true;
      else if (value === 'false') prefs[key] = false;
      else prefs[key] = value;
    }
  }

  return c.json(prefs);
});

export default app;
