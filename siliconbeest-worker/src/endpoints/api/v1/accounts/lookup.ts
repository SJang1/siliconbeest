import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

function safeJsonParse<T>(val: string | null, fallback: T): T {
  if (!val) return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

const app = new Hono<HonoEnv>();

app.get('/lookup', async (c) => {
  const acct = c.req.query('acct');
  const instanceDomain = c.env.INSTANCE_DOMAIN;

  if (!acct) {
    throw new AppError(400, 'Validation failed', 'acct is required');
  }

  // Parse acct: "user" (local) or "user@domain" (remote)
  const cleaned = acct.replace(/^@/, '');
  const parts = cleaned.split('@');
  const username = parts[0]!;
  const acctDomain = parts[1] || null;

  let row;
  if (!acctDomain || acctDomain === instanceDomain) {
    // Local account
    row = await c.env.DB.prepare(
      'SELECT * FROM accounts WHERE username = ?1 AND domain IS NULL',
    ).bind(username).first();
  } else {
    // Remote account — check if we have it cached
    row = await c.env.DB.prepare(
      'SELECT * FROM accounts WHERE username = ?1 AND domain = ?2',
    ).bind(username, acctDomain).first();
  }

  if (!row) throw new AppError(404, 'Record not found');
  const domain = row.domain as string | null;

  return c.json({
    id: row.id as string,
    username: row.username as string,
    acct: domain ? `${row.username}@${domain}` : (row.username as string),
    display_name: (row.display_name as string) || '',
    locked: !!(row.locked),
    bot: !!(row.bot),
    discoverable: !!(row.discoverable),
    group: false,
    created_at: row.created_at as string,
    note: (row.note as string) || '',
    url: (row.url as string) || `https://${instanceDomain}/@${row.username}`,
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
  });
});

export default app;
