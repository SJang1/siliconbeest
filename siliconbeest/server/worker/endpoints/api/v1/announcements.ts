import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../types';
import { authOptional, authRequired } from '../../../middleware/auth';
import { AppError } from '../../../middleware/errorHandler';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

// GET /api/v1/announcements — list published announcements
app.get('/', authOptional, async (c) => {
  const currentAccount = c.get('currentAccount');

  const { results } = await env.DB.prepare(
    `SELECT * FROM announcements
     WHERE published_at IS NOT NULL
     ORDER BY created_at DESC`,
  ).all();

  // Get dismissed announcement IDs for the current user (if authenticated)
  let dismissedIds = new Set<string>();
  if (currentAccount) {
    const { results: dismissedRows } = await env.DB.prepare(
      'SELECT announcement_id FROM announcement_dismissals WHERE account_id = ?1',
    )
      .bind(currentAccount.id)
      .all();

    dismissedIds = new Set(
      (dismissedRows ?? []).map((r: any) => r.announcement_id as string),
    );
  }

  const announcements = (results ?? []).map((row: any) => ({
    id: row.id as string,
    content: row.text as string,
    starts_at: (row.starts_at as string) || null,
    ends_at: (row.ends_at as string) || null,
    all_day: !!(row.all_day as number),
    published_at: row.created_at as string,
    updated_at: row.updated_at as string,
    read: dismissedIds.has(row.id as string),
    mentions: [],
    statuses: [],
    tags: [],
    emojis: [],
    reactions: [],
  }));

  return c.json(announcements);
});

// POST /api/v1/announcements/:id/dismiss — dismiss announcement
app.post('/:id/dismiss', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const announcementId = c.req.param('id');

  const announcement = await env.DB.prepare(
    'SELECT id FROM announcements WHERE id = ?1 AND published_at IS NOT NULL',
  )
    .bind(announcementId)
    .first();

  if (!announcement) {
    throw new AppError(404, 'Record not found');
  }

  await env.DB.prepare(
    'INSERT OR IGNORE INTO announcement_dismissals (announcement_id, account_id) VALUES (?1, ?2)',
  )
    .bind(announcementId, currentAccount.id)
    .run();

  return c.json({}, 200);
});

export default app;
