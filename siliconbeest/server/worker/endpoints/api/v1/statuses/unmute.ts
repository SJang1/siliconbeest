import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { env } from 'cloudflare:workers';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';
import { STATUS_JOIN_SQL, serializeStatusEnriched } from './fetch';
import { unmuteStatus } from '../../../../services/status';
import { canViewStatusById } from '../../../../services/permissions';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.post('/:id/unmute', authRequired, requireScope('write:mutes'), async (c) => {
  const statusId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;
  const domain = env.INSTANCE_DOMAIN;

  const row = await env.DB.prepare(
    `${STATUS_JOIN_SQL} WHERE s.id = ?1 AND s.deleted_at IS NULL`,
  ).bind(statusId).first();
  if (!row) throw new AppError(404, 'Record not found');

  const canView = await canViewStatusById(statusId, currentAccountId);
  const changed = await unmuteStatus(currentAccountId, statusId);
  c.set('contributionApplied', changed);
  if (!canView) throw new AppError(404, 'Record not found');

  const status = await serializeStatusEnriched(row as Record<string, unknown>, domain, currentAccountId, env.CACHE);
  status.muted = false;
  return c.json(status);
});

export default app;
