/**
 * PUT /api/v1/push/subscription — Update push subscription alerts / policy
 *
 * Body (form or JSON):
 *   data[alerts][mention]        — boolean
 *   data[alerts][status]         — boolean
 *   data[alerts][reblog]         — boolean
 *   data[alerts][follow]         — boolean
 *   data[alerts][follow_request] — boolean
 *   data[alerts][favourite]      — boolean
 *   data[alerts][poll]           — boolean
 *   data[alerts][update]         — boolean
 *   data[alerts][admin.sign_up]  — boolean
 *   data[alerts][admin.report]   — boolean
 *   data[policy]                 — all | followed | follower | none
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.put('/', authRequired, async (c) => {
  const authHeader = c.req.header('Authorization')!;
  const accessToken = authHeader.slice(7);

  // Fetch existing subscription
  const existing = await c.env.DB.prepare(
    `SELECT id, endpoint, key_p256dh, key_auth, alerts, policy
     FROM web_push_subscriptions
     WHERE access_token = ?1
     LIMIT 1`,
  )
    .bind(accessToken)
    .first();

  if (!existing) {
    return c.json({ error: 'Record not found' }, 404);
  }

  // Parse body
  let body: Record<string, unknown>;
  const contentType = c.req.header('Content-Type') || '';
  if (contentType.includes('application/json')) {
    body = await c.req.json();
  } else {
    body = Object.fromEntries((await c.req.parseBody({ all: true })) as any);
  }

  // Merge alerts
  let currentAlerts: Record<string, boolean>;
  try {
    currentAlerts = JSON.parse(existing.alerts as string);
  } catch {
    currentAlerts = {};
  }

  const alertsRaw = (body as any)?.data?.alerts ?? {};
  const alertKeys = [
    'mention', 'status', 'reblog', 'follow', 'follow_request',
    'favourite', 'poll', 'update', 'admin.sign_up', 'admin.report',
  ];

  for (const key of alertKeys) {
    const flatKey = `data[alerts][${key}]`;
    const value = alertsRaw[key] ?? (body as any)[flatKey];
    if (value !== undefined) {
      currentAlerts[key] = value === true || value === 'true' || value === '1';
    }
  }

  const policy =
    (body as any)?.data?.policy ??
    (body as any)['data[policy]'] ??
    existing.policy;

  await c.env.DB.prepare(
    `UPDATE web_push_subscriptions
     SET alerts = ?1, policy = ?2, updated_at = datetime('now')
     WHERE access_token = ?3`,
  )
    .bind(JSON.stringify(currentAlerts), policy, accessToken)
    .run();

  return c.json({
    id: existing.id,
    endpoint: existing.endpoint,
    alerts: currentAlerts,
    policy,
    server_key: c.env.VAPID_PUBLIC_KEY,
  });
});

export default app;
