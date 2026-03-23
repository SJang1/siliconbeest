import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';
import { STATUS_JOIN_SQL, serializeStatus } from './fetch';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.post('/:id/unreblog', authRequired, async (c) => {
  const statusId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;
  const domain = c.env.INSTANCE_DOMAIN;

  const row = await c.env.DB.prepare(
    `${STATUS_JOIN_SQL} WHERE s.id = ?1 AND s.deleted_at IS NULL`,
  ).bind(statusId).first();
  if (!row) throw new AppError(404, 'Record not found');

  const reblog = await c.env.DB.prepare(
    'SELECT id FROM statuses WHERE reblog_of_id = ?1 AND account_id = ?2 AND deleted_at IS NULL',
  ).bind(statusId, currentAccountId).first();

  if (reblog) {
    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE statuses SET deleted_at = ?1 WHERE id = ?2').bind(now, reblog.id as string),
      c.env.DB.prepare('UPDATE statuses SET reblogs_count = MAX(0, reblogs_count - 1) WHERE id = ?1').bind(statusId),
      c.env.DB.prepare('UPDATE accounts SET statuses_count = MAX(0, statuses_count - 1) WHERE id = ?1').bind(currentAccountId),
    ]);
  }

  const status = serializeStatus(row as Record<string, unknown>, domain);
  status.reblogged = false;
  if (reblog) {
    status.reblogs_count = Math.max(0, status.reblogs_count - 1);
  }

  return c.json(status);
});

export default app;
