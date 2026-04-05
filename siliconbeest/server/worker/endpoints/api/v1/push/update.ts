/**
 * PUT /api/v1/push/subscription — Update push subscription alerts / policy
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { getVapidPublicKey } from '../../../../utils/vapid';
import { getPushSubscription, updatePushSubscription } from '../../../../services/push';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const ALERT_MAP: Record<string, string> = {
  mention: 'alert_mention',
  follow: 'alert_follow',
  favourite: 'alert_favourite',
  reblog: 'alert_reblog',
  poll: 'alert_poll',
  status: 'alert_status',
  update: 'alert_update',
  follow_request: 'alert_follow_request',
  'admin.sign_up': 'alert_admin_sign_up',
  'admin.report': 'alert_admin_report',
};

app.put('/', authRequired, requireScope('push'), async (c) => {
  const tokenId = c.get('tokenId')!;

  const existing = await getPushSubscription(c.env.DB, tokenId);

  if (!existing) {
    return c.json({ error: 'Record not found' }, 404);
  }

  // Parse body
  let body: Record<string, unknown>;
  const contentType = c.req.header('Content-Type') || '';
  if (contentType.includes('application/json')) {
    body = await c.req.json();
  } else {
    body = Object.fromEntries(Object.entries(await c.req.parseBody({ all: true })));
  }

  // Build SET clauses for changed alerts
  const dataObj = body.data as Record<string, unknown> | undefined;
  const alertsRaw = (dataObj?.alerts as Record<string, unknown> | undefined) ?? {};
  const sets: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  for (const [apiKey, colName] of Object.entries(ALERT_MAP)) {
    const flatKey = `data[alerts][${apiKey}]`;
    const value = alertsRaw[apiKey] ?? body[flatKey];
    if (value !== undefined) {
      sets.push(`${colName} = ?${paramIdx++}`);
      params.push(value === true || value === 'true' || value === '1' ? 1 : 0);
    }
  }

  const policy =
    (dataObj?.policy as string | undefined) ??
    (body['data[policy]'] as string | undefined);
  if (policy !== undefined) {
    sets.push(`policy = ?${paramIdx++}`);
    params.push(policy);
  }

  const row = await updatePushSubscription(c.env.DB, existing.id as string, { sets, params });

  return c.json({
    id: row.id,
    endpoint: row.endpoint,
    alerts: {
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
    },
    policy: row.policy,
    server_key: await getVapidPublicKey(c.env.DB),
  });
});

export default app;
