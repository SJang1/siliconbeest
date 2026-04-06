/**
 * Instance Peers API
 *
 * GET / — Returns a list of domains that this instance has encountered.
 * No authentication required.
 */

import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { getPeers } from '../../../../services/instance';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.get('/', async (c) => {
  const domains = await getPeers();
  return c.json(domains);
});

export default app;
