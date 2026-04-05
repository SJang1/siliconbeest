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
import { requireScope } from '../../../../middleware/scopeCheck';
import { getVapidPublicKey } from '../../../../utils/vapid';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

function toBool(value: unknown): number {
  return value === true || value === 'true' || value === '1' ? 1 : 0;
}

app.post('/', authRequired, requireScope('push'), async (c) => {
  const user = c.get('currentUser')!;

  const authHeader = c.req.header('Authorization')!;
  const rawToken = authHeader.slice(7);

  // Look up the access token ID
  const tokenRow = await c.env.DB.prepare(
    'SELECT id FROM oauth_access_tokens WHERE token = ?1',
  ).bind(rawToken).first();

  if (!tokenRow) {
    return c.json({ error: 'Invalid access token' }, 401);
  }
  const accessTokenId = tokenRow.id as string;

  // Parse body
  let body: Record<string, unknown>;
  const contentType = c.req.header('Content-Type') || '';
  if (contentType.includes('application/json')) {
    body = await c.req.json();
  } else {
    body = Object.fromEntries((await c.req.parseBody({ all: true })) as any);
  }

  // Extract subscription params
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
  const alertsRaw = (body as any)?.data?.alerts ?? {};
  function getAlert(key: string): number {
    const flatKey = `data[alerts][${key}]`;
    const value = alertsRaw[key] ?? (body as any)[flatKey];
    return toBool(value);
  }

  const alertMention = getAlert('mention');
  const alertFollow = getAlert('follow');
  const alertFavourite = getAlert('favourite');
  const alertReblog = getAlert('reblog');
  const alertPoll = getAlert('poll');
  const alertStatus = getAlert('status');
  const alertUpdate = getAlert('update');
  const alertFollowRequest = getAlert('follow_request');
  const alertAdminSignUp = getAlert('admin.sign_up');
  const alertAdminReport = getAlert('admin.report');

  const policy =
    (body as any)?.data?.policy ??
    (body as any)['data[policy]'] ??
    'all';

  const id = crypto.randomUUID();

  await c.env.DB.batch([
    c.env.DB.prepare(
      'DELETE FROM web_push_subscriptions WHERE access_token_id = ?1',
    ).bind(accessTokenId),
    c.env.DB.prepare(
      `INSERT INTO web_push_subscriptions
         (id, user_id, access_token_id, endpoint, key_p256dh, key_auth,
          alert_mention, alert_follow, alert_favourite, alert_reblog,
          alert_poll, alert_status, alert_update, alert_follow_request,
          alert_admin_sign_up, alert_admin_report, policy, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, datetime('now'), datetime('now'))`,
    ).bind(
      id, user.id, accessTokenId, endpoint, p256dh, auth,
      alertMention, alertFollow, alertFavourite, alertReblog,
      alertPoll, alertStatus, alertUpdate, alertFollowRequest,
      alertAdminSignUp, alertAdminReport, policy,
    ),
  ]);

  const alerts: Record<string, boolean> = {
    mention: !!alertMention,
    follow: !!alertFollow,
    favourite: !!alertFavourite,
    reblog: !!alertReblog,
    poll: !!alertPoll,
    status: !!alertStatus,
    update: !!alertUpdate,
    follow_request: !!alertFollowRequest,
    'admin.sign_up': !!alertAdminSignUp,
    'admin.report': !!alertAdminReport,
  };

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
