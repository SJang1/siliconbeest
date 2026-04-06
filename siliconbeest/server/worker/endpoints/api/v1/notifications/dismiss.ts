import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { dismissNotification } from '../../../../services/notification';

const app = new Hono<{ Variables: AppVariables }>();

app.post('/:id/dismiss', authRequired, requireScope('write:notifications'), async (c) => {
  const account = c.get('currentAccount')!;
  const id = c.req.param('id');

  await dismissNotification(id, account.id);

  return c.json({});
});

export default app;
