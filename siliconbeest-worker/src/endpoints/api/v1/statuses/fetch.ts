import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authOptional } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';
import { enrichStatuses } from '../../../../utils/statusEnrichment';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

/** Convert any date string to ISO 8601 with milliseconds */
function toISO(d: unknown): string {
  if (!d || typeof d !== 'string') return new Date().toISOString();
  try { return new Date(d).toISOString(); } catch { return d as string; }
}

function parseAccountEmojiTags(
  emojiTagsJson: string | null | undefined,
  acctDomain: string | null,
  instanceDomain: string,
): Array<{ shortcode: string; url: string; static_url: string; visible_in_picker: boolean }> {
  if (!emojiTagsJson || !acctDomain) return [];
  try {
    const tags = JSON.parse(emojiTagsJson) as Array<{ shortcode?: string; name?: string; url?: string; static_url?: string }>;
    return tags.map((t) => {
      const sc = t.shortcode || (t.name || '').replace(/^:|:$/g, '');
      const rawUrl = t.url || '';
      const rawStatic = t.static_url || rawUrl;
      const proxyIt = (u: string) => {
        if (!u) return u;
        try {
          const parsed = new URL(u);
          if (parsed.hostname === instanceDomain) return u;
          return `https://${instanceDomain}/proxy?url=${encodeURIComponent(u)}`;
        } catch { return u; }
      };
      return { shortcode: sc, url: proxyIt(rawUrl), static_url: proxyIt(rawStatic), visible_in_picker: false };
    });
  } catch { return []; }
}

function serializeStatus(row: Record<string, unknown>, domain: string, currentAccountId?: string, accountEmojis?: any[]) {
  const acct = row.account_domain
    ? `${row.account_username}@${row.account_domain}`
    : (row.account_username as string);

  // Derive account emojis from emoji_tags if not explicitly provided
  const resolvedAccountEmojis = (accountEmojis && accountEmojis.length > 0)
    ? accountEmojis
    : parseAccountEmojiTags(
        row.account_emoji_tags as string | null,
        row.account_domain as string | null,
        domain,
      );

  return {
    id: row.id as string,
    created_at: toISO(row.created_at),
    in_reply_to_id: (row.in_reply_to_id as string) || null,
    in_reply_to_account_id: (row.in_reply_to_account_id as string) || null,
    sensitive: !!(row.sensitive),
    spoiler_text: (row.content_warning as string) || '',
    visibility: (row.visibility as string) || 'public',
    language: (row.language as string) || 'en',
    uri: row.uri as string,
    url: (row.url as string) || null,
    replies_count: (row.replies_count as number) || 0,
    reblogs_count: (row.reblogs_count as number) || 0,
    favourites_count: (row.favourites_count as number) || 0,
    favourited: false,
    reblogged: false,
    muted: false,
    bookmarked: false,
    pinned: false,
    content: (row.content as string) || '',
    filtered: [] as any[],
    reblog: null,
    application: null,
    account: {
      id: row.account_id as string,
      username: row.account_username as string,
      acct,
      display_name: (row.account_display_name as string) || '',
      locked: !!(row.account_locked),
      bot: !!(row.account_bot),
      discoverable: !!(row.account_discoverable),
      group: false,
      created_at: toISO(row.account_created_at),
      note: (row.account_note as string) || '',
      url: (row.account_url as string) || `https://${domain}/@${row.account_username}`,
      uri: row.account_uri as string,
      avatar: (row.account_avatar_url as string) || '',
      avatar_static: (row.account_avatar_static_url as string) || (row.account_avatar_url as string) || '',
      header: (row.account_header_url as string) || '',
      header_static: (row.account_header_static_url as string) || (row.account_header_url as string) || '',
      followers_count: (row.account_followers_count as number) || 0,
      following_count: (row.account_following_count as number) || 0,
      statuses_count: (row.account_statuses_count as number) || 0,
      last_status_at: (row.account_last_status_at as string) || null,
      emojis: resolvedAccountEmojis,
      roles: [],
      fields: [],
    },
    media_attachments: [] as any[],
    mentions: [],
    tags: [],
    emojis: [],
    card: null,
    poll: null,
    edited_at: (row.edited_at as string) || null,
  };
}

/**
 * Serialize a status with enrichment (media + interaction states).
 * Use this for single-status endpoints (favourite, reblog, fetch, etc.)
 */
async function serializeStatusEnriched(
  row: Record<string, unknown>,
  db: D1Database,
  domain: string,
  currentAccountId?: string | null,
  cache?: KVNamespace,
) {
  const statusId = row.id as string;
  const enrichments = await enrichStatuses(db, domain, [statusId], currentAccountId, cache);
  const e = enrichments.get(statusId);
  const status = serializeStatus(row, domain, undefined, e?.accountEmojis);
  if (e) {
    status.media_attachments = e.mediaAttachments as any[];
    status.favourited = e.favourited ?? false;
    status.reblogged = e.reblogged ?? false;
    status.bookmarked = e.bookmarked ?? false;
    status.card = e.card ?? null;
    status.emojis = e.emojis ?? [];
    status.mentions = e.mentions ?? [];
  }
  return status;
}

const STATUS_JOIN_SQL = `
  SELECT s.*,
    a.username AS account_username, a.domain AS account_domain,
    a.display_name AS account_display_name, a.note AS account_note,
    a.uri AS account_uri, a.url AS account_url,
    a.avatar_url AS account_avatar_url, a.avatar_static_url AS account_avatar_static_url,
    a.header_url AS account_header_url, a.header_static_url AS account_header_static_url,
    a.locked AS account_locked, a.bot AS account_bot, a.discoverable AS account_discoverable,
    a.followers_count AS account_followers_count, a.following_count AS account_following_count,
    a.statuses_count AS account_statuses_count, a.last_status_at AS account_last_status_at,
    a.created_at AS account_created_at, a.emoji_tags AS account_emoji_tags
  FROM statuses s
  JOIN accounts a ON a.id = s.account_id
`;

const app = new Hono<HonoEnv>();

app.get('/:id', authOptional, async (c) => {
  const statusId = c.req.param('id');
  const currentAccountId = c.get('currentUser')?.account_id ?? null;
  const domain = c.env.INSTANCE_DOMAIN;

  const row = await c.env.DB.prepare(
    `${STATUS_JOIN_SQL} WHERE s.id = ?1 AND s.deleted_at IS NULL`,
  ).bind(statusId).first();

  if (!row) throw new AppError(404, 'Record not found');

  return c.json(await serializeStatusEnriched(row as Record<string, unknown>, c.env.DB, domain, currentAccountId, c.env.CACHE));
});

export { STATUS_JOIN_SQL, serializeStatus, serializeStatusEnriched };
export default app;
