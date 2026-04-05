/**
 * DELETE /api/v1/push/subscription — Remove push subscription
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { deletePushSubscription } from '../../../../services/push';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.delete('/', authRequired, requireScope('push'), async (c) => {
  const tokenId = c.get('tokenId')!;

  await deletePushSubscription(c.env.DB, tokenId);

  return c.json({});
});

export default app;
