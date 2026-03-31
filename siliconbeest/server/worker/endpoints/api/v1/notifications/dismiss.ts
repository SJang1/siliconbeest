import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.post('/:id/dismiss', authRequired, requireScope('write:notifications'), async (c) => {
  const account = c.get('currentAccount')!;
  const id = c.req.param('id');

  const result = await c.env.DB.prepare(
    `DELETE FROM notifications WHERE id = ?1 AND account_id = ?2`,
  ).bind(id, account.id).run();

  if (!result.meta.changes || result.meta.changes === 0) {
    return c.json({ error: 'Record not found' }, 404);
  }

  return c.json({});
});

export default app;
