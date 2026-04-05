/**
 * GET /api/v1/push/subscription — Get current push subscription
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { getVapidPublicKey } from '../../../../utils/vapid';
import { getPushSubscription } from '../../../../services/push';

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
  const tokenId = c.get('tokenId')!;

  const row = await getPushSubscription(c.env.DB, tokenId);

  if (!row) {
    return c.json({ error: 'Record not found' }, 404);
  }

  return c.json({
    id: row.id,
    endpoint: row.endpoint,
    alerts: rowToAlerts(row),
    policy: row.policy,
    server_key: await getVapidPublicKey(c.env.DB),
  });
});

export default app;
