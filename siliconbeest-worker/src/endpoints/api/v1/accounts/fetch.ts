import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';
import { fetchAccountEmojis, getAccountEmojis } from '../../../../utils/statusEnrichment';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

function safeJsonParse<T>(val: string | null, fallback: T): T {
  if (!val) return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

const app = new Hono<HonoEnv>();

app.get('/:id', async (c) => {
  const id = c.req.param('id');
  const domain = c.env.INSTANCE_DOMAIN;

  const row = await c.env.DB.prepare('SELECT * FROM accounts WHERE id = ?1').bind(id).first();
  if (!row) throw new AppError(404, 'Record not found');

  const acct = row.domain ? `${row.username}@${row.domain}` : (row.username as string);
  const displayName = (row.display_name as string) || '';
  const note = (row.note as string) || '';
  const acctDomain = (row.domain as string) || null;

  // Fetch account emojis
  const emojiMap = await fetchAccountEmojis(c.env.DB, [displayName, note], acctDomain);
  const acctEmojis = getAccountEmojis(emojiMap, displayName, note);

  return c.json({
    id: row.id as string,
    username: row.username as string,
    acct,
    display_name: displayName,
    locked: !!(row.locked),
    bot: !!(row.bot),
    discoverable: !!(row.discoverable),
    group: false,
    created_at: row.created_at as string,
    note,
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
    emojis: acctEmojis,
    fields: safeJsonParse(row.fields as string | null, []),
  });
});

export default app;
