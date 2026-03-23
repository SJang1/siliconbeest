import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.post('/:id/unfollow', authRequired, async (c) => {
  const targetId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;

  const target = await c.env.DB.prepare('SELECT id FROM accounts WHERE id = ?1').bind(targetId).first();
  if (!target) throw new AppError(404, 'Record not found');

  // Remove follow
  const follow = await c.env.DB.prepare(
    'SELECT id FROM follows WHERE account_id = ?1 AND target_account_id = ?2',
  ).bind(currentAccountId, targetId).first();

  if (follow) {
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM follows WHERE id = ?1').bind(follow.id as string),
      c.env.DB.prepare('UPDATE accounts SET following_count = MAX(0, following_count - 1) WHERE id = ?1').bind(currentAccountId),
      c.env.DB.prepare('UPDATE accounts SET followers_count = MAX(0, followers_count - 1) WHERE id = ?1').bind(targetId),
    ]);
  }

  // Also remove any pending follow request
  await c.env.DB.prepare(
    'DELETE FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2',
  ).bind(currentAccountId, targetId).run();

  return c.json({
    id: targetId,
    following: false,
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
