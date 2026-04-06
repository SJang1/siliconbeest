import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../../types';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import list from './list';
import fetch from './fetch';
import clear from './clear';
import dismiss from './dismiss';

const app = new Hono<{ Variables: AppVariables }>();

// GET /unread_count — number of unread notifications
app.get('/unread_count', authRequired, requireScope('read:notifications'), async (c) => {
  const account = c.get('currentAccount')!;
  const row = await env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM notifications WHERE account_id = ?1 AND read = 0',
  ).bind(account.id).first<{ cnt: number }>();
  return c.json({ count: row?.cnt ?? 0 });
});

// POST /read — mark specific notifications as read
app.post('/read', authRequired, requireScope('write:notifications'), async (c) => {
  const account = c.get('currentAccount')!;
  const body = await c.req.json<{ id?: string; max_id?: string }>();

  if (body.id) {
    // Mark single notification as read
    await env.DB.prepare(
      'UPDATE notifications SET read = 1 WHERE id = ?1 AND account_id = ?2',
    ).bind(body.id, account.id).run();
  } else if (body.max_id) {
    // Mark all up to max_id as read
    await env.DB.prepare(
      'UPDATE notifications SET read = 1 WHERE account_id = ?1 AND id <= ?2 AND read = 0',
    ).bind(account.id, body.max_id).run();
  } else {
    // Mark all as read
    await env.DB.prepare(
      'UPDATE notifications SET read = 1 WHERE account_id = ?1 AND read = 0',
    ).bind(account.id).run();
  }

  // Count remaining unread
  const row = await env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM notifications WHERE account_id = ?1 AND read = 0',
  ).bind(account.id).first<{ cnt: number }>();

  // Send streaming event to clear badge
  try {
    const user = c.get('currentUser')!;
    const doId = env.STREAMING_DO.idFromName(user.id);
    const stub = env.STREAMING_DO.get(doId);
    await stub.fetch(new Request('http://internal/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'notifications_read',
        payload: JSON.stringify({ count: row?.cnt ?? 0 }),
        stream: ['user', 'user:notification'],
      }),
    }));
  } catch { /* non-critical */ }

  return c.json({ count: row?.cnt ?? 0 });
});

// GET / — list notifications
app.route('/', list);
// POST /clear — clear all
app.route('/', clear);
// POST /:id/dismiss — dismiss single
app.route('/', dismiss);
// GET /:id — single notification (must be last to avoid catching /clear)
app.route('/', fetch);

export default app;
