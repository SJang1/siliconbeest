/**
 * POST /api/v1/push/subscription — Create a Web Push subscription
 *
 * Each access token can have ONE active push subscription.
 * Creating a new subscription replaces any existing one for that token.
 *
 * Body (form or JSON):
 *   subscription[endpoint]       — push service URL
 *   subscription[keys][p256dh]   — user agent public key (Base64url)
 *   subscription[keys][auth]     — auth secret (Base64url)
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
 *
 * Response: WebPushSubscription entity
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { getVapidPublicKey } from '../../../../utils/vapid';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.post('/', authRequired, async (c) => {
  const user = c.get('currentUser')!;

  // Extract the raw bearer token to associate the subscription with this token
  const authHeader = c.req.header('Authorization')!;
  const accessToken = authHeader.slice(7); // strip "Bearer "

  // Parse body — support both JSON and form data
  let body: Record<string, unknown>;
  const contentType = c.req.header('Content-Type') || '';
  if (contentType.includes('application/json')) {
    body = await c.req.json();
  } else {
    body = Object.fromEntries((await c.req.parseBody({ all: true })) as any);
  }

  // Extract subscription params (handle both nested and flat key formats)
  const endpoint =
    (body as any)?.subscription?.endpoint ??
    (body as any)['subscription[endpoint]'] ??
    null;
  const p256dh =
    (body as any)?.subscription?.keys?.p256dh ??
    (body as any)['subscription[keys][p256dh]'] ??
    null;
  const auth =
    (body as any)?.subscription?.keys?.auth ??
    (body as any)['subscription[keys][auth]'] ??
    null;

  if (!endpoint || !p256dh || !auth) {
    return c.json(
      { error: 'Missing required subscription fields (endpoint, keys.p256dh, keys.auth)' },
      422,
    );
  }

  // Extract alert preferences
  const alertDefaults = {
    mention: false,
    status: false,
    reblog: false,
    follow: false,
    follow_request: false,
    favourite: false,
    poll: false,
    update: false,
    'admin.sign_up': false,
    'admin.report': false,
  };

  const alertsRaw =
    (body as any)?.data?.alerts ?? {};

  const alerts: Record<string, boolean> = {};
  for (const key of Object.keys(alertDefaults)) {
    const flatKey = `data[alerts][${key}]`;
    const value = alertsRaw[key] ?? (body as any)[flatKey];
    alerts[key] = value === true || value === 'true' || value === '1';
  }

  const policy =
    (body as any)?.data?.policy ??
    (body as any)['data[policy]'] ??
    'all';

  // Generate a unique ID for this subscription
  const id = crypto.randomUUID();

  // Upsert: delete existing subscription for this access token, then insert
  await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM web_push_subscriptions WHERE access_token = ?1`,
    ).bind(accessToken),
    c.env.DB.prepare(
      `INSERT INTO web_push_subscriptions
         (id, user_id, access_token, endpoint, key_p256dh, key_auth, alerts, policy, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'), datetime('now'))`,
    ).bind(
      id,
      user.id,
      accessToken,
      endpoint,
      p256dh,
      auth,
      JSON.stringify(alerts),
      policy,
    ),
  ]);

  return c.json(
    {
      id,
      endpoint,
      alerts,
      policy,
      server_key: await getVapidPublicKey(c.env.DB, c.env),
    },
    200,
  );
});

export default app;
