import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { env } from 'cloudflare:workers';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';
import { STATUS_JOIN_SQL, serializeStatusEnriched } from './fetch';
import { pinStatus } from '../../../../services/status';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.post('/:id/pin', authRequired, requireScope('write:accounts'), async (c) => {
  const statusId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;
  const domain = env.INSTANCE_DOMAIN;

  const row = await env.DB.prepare(
    `${STATUS_JOIN_SQL} WHERE s.id = ?1 AND s.deleted_at IS NULL`,
  ).bind(statusId).first();
  if (!row) throw new AppError(404, 'Record not found');

  if ((row as Record<string, unknown>).account_id !== currentAccountId) {
    throw new AppError(403, 'Forbidden', 'You can only pin your own statuses');
  }

  await pinStatus(currentAccountId, statusId);

  const status = await serializeStatusEnriched(row as Record<string, unknown>, domain, currentAccountId, env.CACHE);
  status.pinned = true;
  return c.json(status);
});

export default app;
