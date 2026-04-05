import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { clearAllNotifications } from '../../../../services/notification';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.post('/clear', authRequired, requireScope('write:notifications'), async (c) => {
  const account = c.get('currentAccount')!;

  await clearAllNotifications(c.env.DB, account.id);

  return c.json({});
});

export default app;
