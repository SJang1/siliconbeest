/**
 * POST /api/v1/push/subscription — Create a Web Push subscription
 *
 * Each access token can have ONE active push subscription.
 * Creating a new subscription replaces any existing one for that token.
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
  const tokenId = c.get('tokenId')!;

  // Parse body
  let body: Record<string, unknown>;
  const contentType = c.req.header('Content-Type') || '';
  if (contentType.includes('application/json')) {
    body = await c.req.json();
  } else {
    body = Object.fromEntries(Object.entries(await c.req.parseBody({ all: true })));
  }

  // Extract subscription params
  const subscriptionObj = body.subscription as Record<string, unknown> | undefined;
  const subscriptionKeys = subscriptionObj?.keys as Record<string, unknown> | undefined;
  const endpoint =
    (subscriptionObj?.endpoint as string | undefined) ??
    (body['subscription[endpoint]'] as string | undefined) ??
    null;
  const p256dh =
    (subscriptionKeys?.p256dh as string | undefined) ??
    (body['subscription[keys][p256dh]'] as string | undefined) ??
    null;
  const auth =
    (subscriptionKeys?.auth as string | undefined) ??
    (body['subscription[keys][auth]'] as string | undefined) ??
    null;

  if (!endpoint || !p256dh || !auth) {
    return c.json(
      { error: 'Missing required subscription fields (endpoint, keys.p256dh, keys.auth)' },
      422,
    );
  }

  // Validate endpoint is a valid HTTPS URL
  try {
    const endpointUrl = new URL(endpoint);
    if (endpointUrl.protocol !== 'https:') {
      return c.json({ error: 'Push endpoint must use HTTPS' }, 422);
    }
  } catch {
    return c.json({ error: 'Push endpoint is not a valid URL' }, 422);
  }

  // Extract alert preferences
  const dataObj = body.data as Record<string, unknown> | undefined;
  const alertsRaw = (dataObj?.alerts as Record<string, unknown> | undefined) ?? {};
  function getAlert(key: string): number {
    const flatKey = `data[alerts][${key}]`;
    const value = alertsRaw[key] ?? body[flatKey];
    return toBool(value);
  }

  const alertMention = getAlert('mention');
  const alertFollow = getAlert('follow');
  const alertFavourite = getAlert('favourite');
  const alertReblog = getAlert('reblog');
  const alertPoll = 0; // poll expiry notifications not implemented
  const alertStatus = getAlert('status');
  const alertUpdate = getAlert('update');
  const alertFollowRequest = getAlert('follow_request');
  const alertAdminSignUp = getAlert('admin.sign_up');
  const alertAdminReport = getAlert('admin.report');

  const policy =
    (dataObj?.policy as string | undefined) ??
    (body['data[policy]'] as string | undefined) ??
    'all';

  const id = crypto.randomUUID();

  await c.env.DB.batch([
    c.env.DB.prepare(
      'DELETE FROM web_push_subscriptions WHERE access_token_id = ?1',
    ).bind(tokenId),
    c.env.DB.prepare(
      `INSERT INTO web_push_subscriptions
         (id, user_id, access_token_id, endpoint, key_p256dh, key_auth,
          alert_mention, alert_follow, alert_favourite, alert_reblog,
          alert_poll, alert_status, alert_update, alert_follow_request,
          alert_admin_sign_up, alert_admin_report, policy, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, datetime('now'), datetime('now'))`,
    ).bind(
      id, user.id, tokenId, endpoint, p256dh, auth,
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
