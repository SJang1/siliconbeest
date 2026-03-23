import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';

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

app.post('/:id/follow', authRequired, async (c) => {
  const targetId = c.req.param('id');
  const currentUser = c.get('currentUser')!;
  const currentAccountId = currentUser.account_id;

  if (currentAccountId === targetId) {
    throw new AppError(422, 'Validation failed', 'You cannot follow yourself');
  }

  const target = await c.env.DB.prepare('SELECT id, locked, manually_approves_followers FROM accounts WHERE id = ?1').bind(targetId).first();
  if (!target) throw new AppError(404, 'Record not found');

  // Check existing follow
  const existingFollow = await c.env.DB.prepare(
    'SELECT id FROM follows WHERE account_id = ?1 AND target_account_id = ?2',
  ).bind(currentAccountId, targetId).first();

  if (existingFollow) {
    return c.json({
      id: targetId,
      following: true,
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
  }

  // Check existing follow request
  const existingRequest = await c.env.DB.prepare(
    'SELECT id FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2',
  ).bind(currentAccountId, targetId).first();

  if (existingRequest) {
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
      requested: true,
      requested_by: false,
      domain_blocking: false,
      endorsed: false,
      note: '',
    });
  }

  const now = new Date().toISOString();
  const id = generateULID();
  const needsApproval = !!(target.locked || target.manually_approves_followers);

  if (needsApproval) {
    await c.env.DB.prepare(
      `INSERT INTO follow_requests (id, account_id, target_account_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)`,
    ).bind(id, currentAccountId, targetId, now).run();

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
      requested: true,
      requested_by: false,
      domain_blocking: false,
      endorsed: false,
      note: '',
    });
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO follows (id, account_id, target_account_id, show_reblogs, notify, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, 0, ?4, ?4)`,
    ).bind(id, currentAccountId, targetId, now),
    c.env.DB.prepare('UPDATE accounts SET following_count = following_count + 1 WHERE id = ?1').bind(currentAccountId),
    c.env.DB.prepare('UPDATE accounts SET followers_count = followers_count + 1 WHERE id = ?1').bind(targetId),
  ]);

  return c.json({
    id: targetId,
    following: true,
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
