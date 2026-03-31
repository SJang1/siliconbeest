import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';
import { STATUS_JOIN_SQL, serializeStatusEnriched } from './fetch';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.post('/:id/pin', authRequired, requireScope('write:accounts'), async (c) => {
  const statusId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;
  const domain = c.env.INSTANCE_DOMAIN;

  const row = await c.env.DB.prepare(
    `${STATUS_JOIN_SQL} WHERE s.id = ?1 AND s.deleted_at IS NULL`,
  ).bind(statusId).first();
  if (!row) throw new AppError(404, 'Record not found');

  if ((row as Record<string, unknown>).account_id !== currentAccountId) {
    throw new AppError(403, 'Forbidden', 'You can only pin your own statuses');
  }

  await c.env.DB.prepare(
    'UPDATE statuses SET pinned = 1 WHERE id = ?1 AND account_id = ?2',
  ).bind(statusId, currentAccountId).run();

  const status = await serializeStatusEnriched(row as Record<string, unknown>, c.env.DB, domain, currentAccountId, c.env.CACHE);
  status.pinned = true;
  return c.json(status);
});

export default app;
