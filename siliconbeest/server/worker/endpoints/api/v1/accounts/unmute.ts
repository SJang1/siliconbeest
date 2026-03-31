import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.post('/:id/unmute', authRequired, requireScope('write:mutes'), async (c) => {
  const targetId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;

  const target = await c.env.DB.prepare('SELECT id FROM accounts WHERE id = ?1').bind(targetId).first();
  if (!target) throw new AppError(404, 'Record not found');

  await c.env.DB.prepare(
    'DELETE FROM mutes WHERE account_id = ?1 AND target_account_id = ?2',
  ).bind(currentAccountId, targetId).run();

  const following = await c.env.DB.prepare(
    'SELECT id FROM follows WHERE account_id = ?1 AND target_account_id = ?2',
  ).bind(currentAccountId, targetId).first();

  return c.json({
    id: targetId,
    following: !!following,
    showing_reblogs: true,
    notifying: false,
    languages: null,
    followed_by: false,
    blocking: false,
    blocked_by: false,
    muting: false,
    muting_notifications: false,
    requested: false,
    requested_by: false,
    domain_blocking: false,
    endorsed: false,
    note: '',
  });
});

export default app;
