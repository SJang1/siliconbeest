import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';
import { STATUS_JOIN_SQL, serializeStatus } from './fetch';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.post('/:id/unfavourite', authRequired, async (c) => {
  const statusId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;
  const domain = c.env.INSTANCE_DOMAIN;

  const row = await c.env.DB.prepare(
    `${STATUS_JOIN_SQL} WHERE s.id = ?1 AND s.deleted_at IS NULL`,
  ).bind(statusId).first();
  if (!row) throw new AppError(404, 'Record not found');

  const existing = await c.env.DB.prepare(
    'SELECT id FROM favourites WHERE account_id = ?1 AND status_id = ?2',
  ).bind(currentAccountId, statusId).first();

  if (existing) {
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM favourites WHERE id = ?1').bind(existing.id as string),
      c.env.DB.prepare('UPDATE statuses SET favourites_count = MAX(0, favourites_count - 1) WHERE id = ?1').bind(statusId),
    ]);
  }

  const status = serializeStatus(row as Record<string, unknown>, domain);
  status.favourited = false;
  if (existing) {
    status.favourites_count = Math.max(0, status.favourites_count - 1);
  }

  return c.json(status);
});

export default app;
