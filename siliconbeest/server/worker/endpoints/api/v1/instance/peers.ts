/**
 * Instance Peers API
 *
 * GET / — Returns a list of domains that this instance has encountered.
 * No authentication required.
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { getPeers } from '../../../../services/instance';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.get('/', async (c) => {
  const domains = await getPeers(c.env.DB);
  return c.json(domains);
});

export default app;
