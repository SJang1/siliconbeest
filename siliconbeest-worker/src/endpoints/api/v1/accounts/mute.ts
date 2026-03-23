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

app.post('/:id/mute', authRequired, async (c) => {
  const targetId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;

  if (currentAccountId === targetId) {
    throw new AppError(422, 'Validation failed', 'You cannot mute yourself');
  }

  const target = await c.env.DB.prepare('SELECT id FROM accounts WHERE id = ?1').bind(targetId).first();
  if (!target) throw new AppError(404, 'Record not found');

  let body: { notifications?: boolean; duration?: number } = {};
  try {
    body = await c.req.json();
  } catch {
    // No body or invalid JSON is OK
  }

  const hideNotifications = body.notifications !== false ? 1 : 0;
  const duration = body.duration || 0;
  const now = new Date().toISOString();
  const expiresAt = duration > 0 ? new Date(Date.now() + duration * 1000).toISOString() : null;

  const existing = await c.env.DB.prepare(
    'SELECT id FROM mutes WHERE account_id = ?1 AND target_account_id = ?2',
  ).bind(currentAccountId, targetId).first();

  if (existing) {
    await c.env.DB.prepare(
      'UPDATE mutes SET hide_notifications = ?1, expires_at = ?2, updated_at = ?3 WHERE id = ?4',
    ).bind(hideNotifications, expiresAt, now, existing.id as string).run();
  } else {
    const id = generateULID();
    await c.env.DB.prepare(
      `INSERT INTO mutes (id, account_id, target_account_id, hide_notifications, expires_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
    ).bind(id, currentAccountId, targetId, hideNotifications, expiresAt, now).run();
  }

  // Check follow status for response
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
    muting: true,
    muting_notifications: !!hideNotifications,
    requested: false,
    requested_by: false,
    domain_blocking: false,
    endorsed: false,
    note: '',
  });
});

export default app;
