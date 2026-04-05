/**
 * DELETE /api/v1/push/subscription — Remove push subscription
 *
 * Deletes the Web Push subscription associated with the current access token.
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.delete('/', authRequired, requireScope('push'), async (c) => {
  const authHeader = c.req.header('Authorization')!;
  const rawToken = authHeader.slice(7);

  await c.env.DB.prepare(
    `DELETE FROM web_push_subscriptions
     WHERE access_token_id = (SELECT id FROM oauth_access_tokens WHERE token = ?1)`,
  )
    .bind(rawToken)
    .run();

  return c.json({});
});

export default app;
