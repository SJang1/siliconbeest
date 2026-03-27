/**
 * Instance Peers API
 *
 * GET / — Returns a list of domains that this instance has encountered.
 * No authentication required.
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT domain FROM instances ORDER BY domain ASC',
  ).all();

  const domains = (results ?? []).map((r) => r.domain as string);
  return c.json(domains);
});

export default app;
