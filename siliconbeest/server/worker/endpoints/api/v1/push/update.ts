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
import { requireScope } from '../../../../middleware/scopeCheck';
import { getVapidPublicKey } from '../../../../utils/vapid';

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
  const authHeader = c.req.header('Authorization')!;
  const rawToken = authHeader.slice(7);

  // Fetch existing subscription via token join
  const existing = await c.env.DB.prepare(
    `SELECT s.id, s.endpoint, s.policy,
            s.alert_mention, s.alert_follow, s.alert_favourite, s.alert_reblog,
            s.alert_poll, s.alert_status, s.alert_update, s.alert_follow_request,
            s.alert_admin_sign_up, s.alert_admin_report,
            t.id AS token_id
     FROM web_push_subscriptions s
     JOIN oauth_access_tokens t ON t.id = s.access_token_id
     WHERE t.token = ?1
     LIMIT 1`,
  )
    .bind(rawToken)
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

  // Build SET clauses for changed alerts
  const alertsRaw = (body as any)?.data?.alerts ?? {};
  const sets: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  for (const [apiKey, colName] of Object.entries(ALERT_MAP)) {
    const flatKey = `data[alerts][${apiKey}]`;
    const value = alertsRaw[apiKey] ?? (body as any)[flatKey];
    if (value !== undefined) {
      sets.push(`${colName} = ?${paramIdx++}`);
      params.push(value === true || value === 'true' || value === '1' ? 1 : 0);
    }
  }

  const policy =
    (body as any)?.data?.policy ??
    (body as any)['data[policy]'];
  if (policy !== undefined) {
    sets.push(`policy = ?${paramIdx++}`);
    params.push(policy);
  }

  sets.push(`updated_at = datetime('now')`);
  params.push(existing.id);

  await c.env.DB.prepare(
    `UPDATE web_push_subscriptions SET ${sets.join(', ')} WHERE id = ?${paramIdx}`,
  )
    .bind(...params)
    .run();

  // Re-read the updated row
  const updated = await c.env.DB.prepare(
    `SELECT id, endpoint, policy,
            alert_mention, alert_follow, alert_favourite, alert_reblog,
            alert_poll, alert_status, alert_update, alert_follow_request,
            alert_admin_sign_up, alert_admin_report
     FROM web_push_subscriptions WHERE id = ?1`,
  ).bind(existing.id).first();

  const row = updated!;
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
    server_key: await getVapidPublicKey(c.env.DB, c.env),
  });
});

export default app;
