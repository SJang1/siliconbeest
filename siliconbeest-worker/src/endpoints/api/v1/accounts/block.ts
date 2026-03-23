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

app.post('/:id/block', authRequired, async (c) => {
  const targetId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;

  if (currentAccountId === targetId) {
    throw new AppError(422, 'Validation failed', 'You cannot block yourself');
  }

  const target = await c.env.DB.prepare('SELECT id FROM accounts WHERE id = ?1').bind(targetId).first();
  if (!target) throw new AppError(404, 'Record not found');

  const existing = await c.env.DB.prepare(
    'SELECT id FROM blocks WHERE account_id = ?1 AND target_account_id = ?2',
  ).bind(currentAccountId, targetId).first();

  if (!existing) {
    const now = new Date().toISOString();
    const id = generateULID();

    // Block and remove any existing follows in both directions
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO blocks (id, account_id, target_account_id, created_at) VALUES (?1, ?2, ?3, ?4)',
      ).bind(id, currentAccountId, targetId, now),
      c.env.DB.prepare('DELETE FROM follows WHERE account_id = ?1 AND target_account_id = ?2').bind(currentAccountId, targetId),
      c.env.DB.prepare('DELETE FROM follows WHERE account_id = ?1 AND target_account_id = ?2').bind(targetId, currentAccountId),
      c.env.DB.prepare('DELETE FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2').bind(currentAccountId, targetId),
      c.env.DB.prepare('DELETE FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2').bind(targetId, currentAccountId),
    ]);
  }

  return c.json({
    id: targetId,
    following: false,
    showing_reblogs: false,
    notifying: false,
    languages: null,
    followed_by: false,
    blocking: true,
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
