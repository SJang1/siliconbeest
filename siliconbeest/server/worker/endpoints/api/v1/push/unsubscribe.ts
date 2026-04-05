/**
 * DELETE /api/v1/push/subscription — Remove push subscription
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.delete('/', authRequired, requireScope('push'), async (c) => {
  const tokenId = c.get('tokenId')!;

  await c.env.DB.prepare(
    'DELETE FROM web_push_subscriptions WHERE access_token_id = ?1',
  )
    .bind(tokenId)
    .run();

  return c.json({});
});

export default app;
