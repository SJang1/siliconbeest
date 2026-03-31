import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';
import { STATUS_JOIN_SQL, serializeStatusEnriched } from './fetch';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

function generateULID(): string {
  const t = Date.now();
  const ts = t.toString(36).padStart(10, '0');
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(10)))
    .map((b) => (b % 36).toString(36))
    .join('');
  return (ts + rand).toUpperCase();
}

const app = new Hono<HonoEnv>();

app.post('/:id/bookmark', authRequired, requireScope('write:bookmarks'), async (c) => {
  const statusId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;
  const domain = c.env.INSTANCE_DOMAIN;

  const row = await c.env.DB.prepare(
    `${STATUS_JOIN_SQL} WHERE s.id = ?1 AND s.deleted_at IS NULL`,
  ).bind(statusId).first();
  if (!row) throw new AppError(404, 'Record not found');

  const existing = await c.env.DB.prepare(
    'SELECT id FROM bookmarks WHERE account_id = ?1 AND status_id = ?2',
  ).bind(currentAccountId, statusId).first();

  if (!existing) {
    const now = new Date().toISOString();
    const id = generateULID();
    await c.env.DB.prepare(
      'INSERT INTO bookmarks (id, account_id, status_id, created_at) VALUES (?1, ?2, ?3, ?4)',
    ).bind(id, currentAccountId, statusId, now).run();
  }

  const status = await serializeStatusEnriched(row as Record<string, unknown>, c.env.DB, domain, currentAccountId, c.env.CACHE);
  status.bookmarked = true;
  return c.json(status);
});

export default app;
