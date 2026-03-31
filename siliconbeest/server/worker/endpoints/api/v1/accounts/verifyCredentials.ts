import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

function safeJsonParse<T>(val: string | null, fallback: T): T {
  if (!val) return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

const app = new Hono<HonoEnv>();

app.get('/verify_credentials', authRequired, requireScope('read:accounts'), async (c) => {
  const user = c.get('currentUser')!;
  const domain = c.env.INSTANCE_DOMAIN;

  const row = await c.env.DB.prepare(
    `SELECT a.*, u.locale, u.role
     FROM accounts a
     JOIN users u ON u.account_id = a.id
     WHERE a.id = ?1`,
  ).bind(user.account_id).first();

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
    avatar: (row.avatar_url as string) || null,
    avatar_static: (row.avatar_static_url as string) || null,
    header: (row.header_url as string) || null,
    header_static: (row.header_static_url as string) || null,
    followers_count: (row.followers_count as number) || 0,
    following_count: (row.following_count as number) || 0,
    statuses_count: (row.statuses_count as number) || 0,
    last_status_at: (row.last_status_at as string) || null,
    emojis: [],
    fields: safeJsonParse(row.fields as string | null, []),
    source: {
      privacy: 'public',
      sensitive: false,
      language: (row.locale as string) || 'en',
      note: (row.note as string) || '',
      fields: safeJsonParse(row.fields as string | null, []),
      follow_requests_count: 0,
    },
    role: {
      id: row.role === 'admin' ? '3' : row.role === 'moderator' ? '2' : '1',
      name: (row.role as string) || 'user',
      permissions: row.role === 'admin' ? '1' : '0',
      highlighted: row.role === 'admin',
    },
  });
});

export default app;
