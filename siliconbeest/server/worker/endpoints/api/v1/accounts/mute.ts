import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../../types';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';
import { createMute, getRelationship } from '../../../../services/account';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.post('/:id/mute', authRequired, requireScope('write:mutes'), async (c) => {
  const targetId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;

  const target = await env.DB.prepare('SELECT id FROM accounts WHERE id = ?1').bind(targetId).first();
  if (!target) throw new AppError(404, 'Record not found');

  let body: { notifications?: boolean; duration?: number } = {};
  try {
    body = await c.req.json();
  } catch {
    // No body or invalid JSON is OK
  }

  const notifications = body.notifications !== false;
  const duration = body.duration || 0;
  const expiresAt = duration > 0 ? new Date(Date.now() + duration * 1000).toISOString() : null;

  await createMute(currentAccountId, targetId, notifications, expiresAt);

  return c.json(await getRelationship(currentAccountId, targetId));
});

export default app;
