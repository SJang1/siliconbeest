import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';
import { removeMute, getRelationship } from '../../../../services/account';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.post('/:id/unmute', authRequired, requireScope('write:mutes'), async (c) => {
  const targetId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;
  const db = c.env.DB;

  const target = await db.prepare('SELECT id FROM accounts WHERE id = ?1').bind(targetId).first();
  if (!target) throw new AppError(404, 'Record not found');

  await removeMute(db, currentAccountId, targetId);

  return c.json(await getRelationship(db, currentAccountId, targetId));
});

export default app;
