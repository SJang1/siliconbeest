import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.patch('/update_credentials', authRequired, async (c) => {
  const currentUser = c.get('currentUser')!;
  const domain = c.env.INSTANCE_DOMAIN;

  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch {
    // Try form data
    try {
      const formData = await c.req.formData();
      for (const [key, value] of formData.entries()) {
        if (typeof value === 'string') body[key] = value;
      }
    } catch {
      throw new AppError(422, 'Validation failed', 'Unable to parse request body');
    }
  }

  const updates: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (body.display_name !== undefined) {
    updates.push(`display_name = ?${paramIdx++}`);
    params.push(body.display_name as string);
  }
  if (body.note !== undefined) {
    updates.push(`note = ?${paramIdx++}`);
    params.push(body.note as string);
  }
  if (body.locked !== undefined) {
    updates.push(`locked = ?${paramIdx++}`);
    params.push(body.locked ? 1 : 0);
  }
  if (body.bot !== undefined) {
    updates.push(`bot = ?${paramIdx++}`);
    params.push(body.bot ? 1 : 0);
  }
  if (body.discoverable !== undefined) {
    updates.push(`discoverable = ?${paramIdx++}`);
    params.push(body.discoverable ? 1 : 0);
  }

  const now = new Date().toISOString();
  updates.push(`updated_at = ?${paramIdx++}`);
  params.push(now);

  params.push(currentUser.account_id);

  if (updates.length > 1) {
    const sql = `UPDATE accounts SET ${updates.join(', ')} WHERE id = ?${paramIdx}`;
    await c.env.DB.prepare(sql).bind(...params).run();
  }

  // Fetch updated account
  const row = await c.env.DB.prepare(
    `SELECT a.*, u.locale, u.role
     FROM accounts a
     JOIN users u ON u.account_id = a.id
     WHERE a.id = ?1`,
  ).bind(currentUser.account_id).first();

  if (!row) throw new AppError(404, 'Record not found');

  const acct = row.domain ? `${row.username}@${row.domain}` : (row.username as string);

  return c.json({
    id: row.id as string,
    username: row.username as string,
    acct,
    display_name: (row.display_name as string) || '',
    locked: !!(row.locked),
    bot: !!(row.bot),
    discoverable: !!(row.discoverable),
    group: false,
    created_at: row.created_at as string,
    note: (row.note as string) || '',
    url: (row.url as string) || `https://${domain}/@${row.username}`,
    uri: row.uri as string,
    avatar: (row.avatar_url as string) || '',
    avatar_static: (row.avatar_static_url as string) || '',
    header: (row.header_url as string) || '',
    header_static: (row.header_static_url as string) || '',
    followers_count: (row.followers_count as number) || 0,
    following_count: (row.following_count as number) || 0,
    statuses_count: (row.statuses_count as number) || 0,
    last_status_at: (row.last_status_at as string) || null,
    emojis: [],
    fields: [],
    source: {
      privacy: 'public',
      sensitive: false,
      language: (row.locale as string) || 'en',
      note: (row.note as string) || '',
      fields: [],
      follow_requests_count: 0,
    },
  });
});

export default app;
