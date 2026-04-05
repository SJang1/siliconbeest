import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { searchAccounts } from '../../../../services/account';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.get('/search', authRequired, async (c) => {
  const query = c.req.query();
  const q = (query.q || '').trim();
  const limit = Math.min(parseInt(query.limit || '40', 10) || 40, 80);
  const following = query.following === 'true';
  const domain = c.env.INSTANCE_DOMAIN;
  const currentAccountId = c.get('currentUser')!.account_id;

  if (!q) return c.json([]);

  const results = await searchAccounts(c.env.DB, q, limit, 0, following ? { followedBy: currentAccountId } : undefined);

  const accounts = (results as Record<string, unknown>[]).map((row) => {
    const acct = row.domain ? `${row.username}@${row.domain}` : (row.username as string);
    const acctDomain = (row.domain as string) || null;

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
          const proxyIt = (u: string) => {
            if (!u) return u;
            try {
              const p = new URL(u);
              if (p.hostname === domain) return u;
              return `https://${domain}/proxy?url=${encodeURIComponent(u)}`;
            } catch { return u; }
          };
          return { shortcode: sc, url: proxyIt(rawUrl), static_url: proxyIt(rawStatic), visible_in_picker: false };
        });
      } catch { /* ignore */ }
    }

    return {
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
      emojis,
      fields: [],
    };
  });

  return c.json(accounts);
});

export default app;
