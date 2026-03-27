import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.post('/clear', authRequired, async (c) => {
  const account = c.get('currentAccount')!;

  await c.env.DB.prepare(
    `DELETE FROM notifications WHERE account_id = ?1`,
  ).bind(account.id).run();

  return c.json({});
});

export default app;
