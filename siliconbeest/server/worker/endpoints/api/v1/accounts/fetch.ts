import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';

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

  // Background refresh for stale remote accounts (2h)
  if (acctDomain && row.uri) {
    const fetchedAt = row.fetched_at as string | null;
    const staleMs = 2 * 60 * 60 * 1000; // 2 hours
    const isStale = !fetchedAt || (Date.now() - new Date(fetchedAt).getTime() > staleMs);
    if (isStale) {
      try {
        await c.env.QUEUE_INTERNAL.send({
          type: 'fetch_remote_account',
          actorUri: row.uri as string,
          forceRefresh: true,
        });
      } catch { /* non-blocking */ }
    }
  }

  const avatarUrl = (row.avatar_url as string) || '';
  const headerUrl = (row.header_url as string) || '';
  const defaultAvatar = `https://${domain}/default-avatar.svg`;
  const defaultHeader = `https://${domain}/default-header.svg`;

  // Proxy remote avatar/header URLs through our media proxy
  const proxyRemote = (url: string): string => {
    if (!url || !acctDomain) return url;
    try {
      const parsed = new URL(url);
      if (parsed.hostname === domain) return url;
      return `https://${domain}/proxy?url=${encodeURIComponent(url)}`;
    } catch { return url; }
  };

  // Parse account emoji_tags and proxy URLs
  let emojis: Array<{ shortcode: string; url: string; static_url: string; visible_in_picker: boolean }> = [];
  const emojiTagsRaw = row.emoji_tags as string | null;
  if (emojiTagsRaw && acctDomain) {
    try {
      const tags = JSON.parse(emojiTagsRaw) as Array<{ shortcode?: string; name?: string; url?: string; static_url?: string }>;
      emojis = tags.map((t) => {
        const sc = t.shortcode || (t.name || '').replace(/^:|:$/g, '');
        const rawUrl = t.url || '';
        const rawStatic = t.static_url || rawUrl;
        return {
          shortcode: sc,
          url: proxyRemote(rawUrl),
          static_url: proxyRemote(rawStatic),
          visible_in_picker: false,
        };
      });
    } catch { /* ignore malformed JSON */ }
  }

  const rawAvatar = avatarUrl || defaultAvatar;
  const rawAvatarStatic = (row.avatar_static_url as string) || avatarUrl || defaultAvatar;
  const rawHeader = headerUrl || defaultHeader;
  const rawHeaderStatic = (row.header_static_url as string) || headerUrl || defaultHeader;

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
    avatar: acctDomain ? proxyRemote(rawAvatar) : rawAvatar,
    avatar_static: acctDomain ? proxyRemote(rawAvatarStatic) : rawAvatarStatic,
    header: acctDomain ? proxyRemote(rawHeader) : rawHeader,
    header_static: acctDomain ? proxyRemote(rawHeaderStatic) : rawHeaderStatic,
    followers_count: (row.followers_count as number) || 0,
    following_count: (row.following_count as number) || 0,
    statuses_count: (row.statuses_count as number) || 0,
    last_status_at: (row.last_status_at as string) || null,
    emojis,
    fields: safeJsonParse(row.fields as string | null, []),
  });
});

export default app;
