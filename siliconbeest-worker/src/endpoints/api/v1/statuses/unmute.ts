import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';
import { STATUS_JOIN_SQL, serializeStatusEnriched } from './fetch';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.post('/:id/unmute', authRequired, async (c) => {
  const statusId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;
  const domain = c.env.INSTANCE_DOMAIN;

  const row = await c.env.DB.prepare(
    `${STATUS_JOIN_SQL} WHERE s.id = ?1 AND s.deleted_at IS NULL`,
  ).bind(statusId).first();
  if (!row) throw new AppError(404, 'Record not found');

  await c.env.DB.prepare(
    'DELETE FROM status_mutes WHERE account_id = ?1 AND status_id = ?2',
  ).bind(currentAccountId, statusId).run();

  const status = await serializeStatusEnriched(row as Record<string, unknown>, c.env.DB, domain, currentAccountId, c.env.CACHE);
  status.muted = false;
  return c.json(status);
});

export default app;
