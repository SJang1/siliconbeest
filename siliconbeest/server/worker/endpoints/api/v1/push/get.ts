/**
 * GET /api/v1/push/subscription — Get current push subscription
 *
 * Returns the active Web Push subscription for the current access token,
 * or 404 if none exists.
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { getVapidPublicKey } from '../../../../utils/vapid';

const ALERT_COLUMNS = [
  'alert_mention', 'alert_follow', 'alert_favourite', 'alert_reblog',
  'alert_poll', 'alert_status', 'alert_update', 'alert_follow_request',
  'alert_admin_sign_up', 'alert_admin_report',
] as const;

function rowToAlerts(row: Record<string, unknown>): Record<string, boolean> {
  return {
    mention: !!(row.alert_mention),
    follow: !!(row.alert_follow),
    favourite: !!(row.alert_favourite),
    reblog: !!(row.alert_reblog),
    poll: !!(row.alert_poll),
    status: !!(row.alert_status),
    update: !!(row.alert_update),
    follow_request: !!(row.alert_follow_request),
    'admin.sign_up': !!(row.alert_admin_sign_up),
    'admin.report': !!(row.alert_admin_report),
  };
}

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get('/', authRequired, requireScope('push'), async (c) => {
  const authHeader = c.req.header('Authorization')!;
  const rawToken = authHeader.slice(7);

  const row = await c.env.DB.prepare(
    `SELECT s.id, s.endpoint, s.policy, s.created_at, s.updated_at,
            s.alert_mention, s.alert_follow, s.alert_favourite, s.alert_reblog,
            s.alert_poll, s.alert_status, s.alert_update, s.alert_follow_request,
            s.alert_admin_sign_up, s.alert_admin_report
     FROM web_push_subscriptions s
     JOIN oauth_access_tokens t ON t.id = s.access_token_id
     WHERE t.token = ?1
     LIMIT 1`,
  )
    .bind(rawToken)
    .first();

  if (!row) {
    return c.json({ error: 'Record not found' }, 404);
  }

  return c.json({
    id: row.id,
    endpoint: row.endpoint,
    alerts: rowToAlerts(row),
    policy: row.policy,
    server_key: await getVapidPublicKey(c.env.DB, c.env),
  });
});

export default app;
