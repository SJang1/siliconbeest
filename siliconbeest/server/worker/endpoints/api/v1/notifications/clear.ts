import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { clearAllNotifications } from '../../../../services/notification';

const app = new Hono<{ Variables: AppVariables }>();

app.post('/clear', authRequired, requireScope('write:notifications'), async (c) => {
  const account = c.get('currentAccount')!;

  await clearAllNotifications(account.id);

  return c.json({});
});

export default app;
