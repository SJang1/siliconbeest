/**
 * GET /api/v1/push/subscription — Get current push subscription
 *
 * Returns the active Web Push subscription for the current access token,
 * or 404 if none exists.
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get('/', authRequired, async (c) => {
  const authHeader = c.req.header('Authorization')!;
  const accessToken = authHeader.slice(7);

  const row = await c.env.DB.prepare(
    `SELECT id, endpoint, key_p256dh, key_auth, alerts, policy, created_at, updated_at
     FROM web_push_subscriptions
     WHERE access_token = ?1
     LIMIT 1`,
  )
    .bind(accessToken)
    .first();

  if (!row) {
    return c.json({ error: 'Record not found' }, 404);
  }

  let alerts: Record<string, boolean>;
  try {
    alerts = JSON.parse(row.alerts as string);
  } catch {
    alerts = {};
  }

  return c.json({
    id: row.id,
    endpoint: row.endpoint,
    alerts,
    policy: row.policy,
    server_key: c.env.VAPID_PUBLIC_KEY,
  });
});

export default app;
