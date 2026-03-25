import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authOptional } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';
import { parsePaginationParams, buildPaginationQuery, buildLinkHeader } from '../../../../utils/pagination';
import { enrichStatuses } from '../../../../utils/statusEnrichment';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

function serializeStatus(row: Record<string, unknown>, domain: string) {
  const acct = row.account_domain
    ? `${row.account_username}@${row.account_domain}`
    : (row.account_username as string);

  return {
    id: row.id as string,
    created_at: row.created_at as string,
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
      created_at: row.account_created_at as string,
      note: (row.account_note as string) || '',
      url: (row.account_url as string) || `https://${domain}/@${row.account_username}`,
      uri: row.account_uri as string,
      avatar: (row.account_avatar_url as string) || null,
      avatar_static: (row.account_avatar_static_url as string) || null,
      header: (row.account_header_url as string) || null,
      header_static: (row.account_header_static_url as string) || null,
      followers_count: (row.account_followers_count as number) || 0,
      following_count: (row.account_following_count as number) || 0,
      statuses_count: (row.account_statuses_count as number) || 0,
      last_status_at: (row.account_last_status_at as string) || null,
      emojis: [],
      fields: [],
    },
    media_attachments: [],
    mentions: [],
    tags: [],
    emojis: [],
    card: null,
    poll: null,
    edited_at: (row.edited_at as string) || null,
  };
}

const app = new Hono<HonoEnv>();

app.get('/:id/statuses', authOptional, async (c) => {
  const accountId = c.req.param('id');
  const domain = c.env.INSTANCE_DOMAIN;

  // Verify account exists
  const account = await c.env.DB.prepare('SELECT id FROM accounts WHERE id = ?1').bind(accountId).first();
  if (!account) throw new AppError(404, 'Record not found');

  const query = c.req.query();
  const pagination = parsePaginationParams({
    max_id: query.max_id,
    since_id: query.since_id,
    min_id: query.min_id,
    limit: query.limit,
  });

  const pag = buildPaginationQuery(pagination, 's.id');

  const onlyMedia = query.only_media === 'true';
  const excludeReplies = query.exclude_replies === 'true';
  const excludeReblogs = query.exclude_reblogs === 'true';
  const pinned = query.pinned === 'true';

  const conditions: string[] = ['s.account_id = ?', 's.deleted_at IS NULL'];
  const params: unknown[] = [accountId];

  if (pag.whereClause) {
    conditions.push(pag.whereClause);
    params.push(...pag.params);
  }

  if (excludeReplies) conditions.push('s.in_reply_to_id IS NULL');
  if (excludeReblogs) conditions.push('s.reblog_of_id IS NULL');
  if (onlyMedia) conditions.push("EXISTS (SELECT 1 FROM media_attachments ma WHERE ma.status_id = s.id)");
  if (pinned) {
    // Pinned statuses not yet implemented; return empty
    return c.json([]);
  }

  const sql = `
    SELECT s.*,
      a.username AS account_username, a.domain AS account_domain,
      a.display_name AS account_display_name, a.note AS account_note,
      a.uri AS account_uri, a.url AS account_url,
      a.avatar_url AS account_avatar_url, a.avatar_static_url AS account_avatar_static_url,
      a.header_url AS account_header_url, a.header_static_url AS account_header_static_url,
      a.locked AS account_locked, a.bot AS account_bot, a.discoverable AS account_discoverable,
      a.followers_count AS account_followers_count, a.following_count AS account_following_count,
      a.statuses_count AS account_statuses_count, a.last_status_at AS account_last_status_at,
      a.created_at AS account_created_at
    FROM statuses s
    JOIN accounts a ON a.id = s.account_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${pag.orderClause}
    LIMIT ?
  `;
  params.push(pag.limitValue);

  const stmt = c.env.DB.prepare(sql);
  const { results } = await stmt.bind(...params).all();

  const statusIds = (results as Record<string, unknown>[]).map((r) => r.id as string);
  const currentAccountId = c.get('currentUser')?.account_id ?? null;
  const enrichments = await enrichStatuses(c.env.DB, domain, statusIds, currentAccountId, c.env.CACHE);

  // Collect reblog_of_ids to fetch original statuses
  const reblogOfIds = (results as Record<string, unknown>[])
    .map((r) => r.reblog_of_id as string | null)
    .filter((id): id is string => !!id);

  const reblogMap = new Map<string, Record<string, unknown>>();
  if (reblogOfIds.length > 0) {
    const placeholders = reblogOfIds.map(() => '?').join(',');
    const { results: reblogResults } = await c.env.DB.prepare(
      `SELECT s.*,
        a.username AS account_username, a.domain AS account_domain,
        a.display_name AS account_display_name, a.note AS account_note,
        a.uri AS account_uri, a.url AS account_url,
        a.avatar_url AS account_avatar_url, a.avatar_static_url AS account_avatar_static_url,
        a.header_url AS account_header_url, a.header_static_url AS account_header_static_url,
        a.locked AS account_locked, a.bot AS account_bot, a.discoverable AS account_discoverable,
        a.followers_count AS account_followers_count, a.following_count AS account_following_count,
        a.statuses_count AS account_statuses_count, a.last_status_at AS account_last_status_at,
        a.created_at AS account_created_at
      FROM statuses s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.id IN (${placeholders}) AND s.deleted_at IS NULL`,
    ).bind(...reblogOfIds).all();
    for (const r of (reblogResults ?? []) as Record<string, unknown>[]) {
      reblogMap.set(r.id as string, r);
    }
  }

  // Enrich reblog originals too
  const allIds = [...statusIds, ...reblogOfIds];
  const allEnrichments = reblogOfIds.length > 0
    ? await enrichStatuses(c.env.DB, domain, allIds, currentAccountId, c.env.CACHE)
    : enrichments;

  const statuses = (results as Record<string, unknown>[]).map((r) => {
    const s = serializeStatus(r, domain);
    const e = (reblogOfIds.length > 0 ? allEnrichments : enrichments).get(r.id as string);
    if (e) {
      s.media_attachments = e.mediaAttachments as any[];
      s.favourited = e.favourited ?? false;
      s.reblogged = e.reblogged ?? false;
      s.bookmarked = e.bookmarked ?? false;
      s.card = e.card ?? null;
      s.emojis = e.emojis ?? [];
    }
    // Fill reblog object
    const reblogOfId = r.reblog_of_id as string | null;
    if (reblogOfId) {
      const origRow = reblogMap.get(reblogOfId);
      if (origRow) {
        const origStatus = serializeStatus(origRow, domain);
        const origE = allEnrichments.get(reblogOfId);
        if (origE) {
          origStatus.media_attachments = origE.mediaAttachments as any[];
          origStatus.favourited = origE.favourited ?? false;
          origStatus.reblogged = origE.reblogged ?? false;
          origStatus.bookmarked = origE.bookmarked ?? false;
          origStatus.card = origE.card ?? null;
          origStatus.emojis = origE.emojis ?? [];
        }
        s.reblog = origStatus as any;
      }
    }
    return s;
  });

  if (pagination.minId) statuses.reverse();

  const baseUrl = `https://${domain}/api/v1/accounts/${accountId}/statuses`;
  const link = buildLinkHeader(baseUrl, statuses, pagination.limit);
  if (link) c.header('Link', link);

  return c.json(statuses);
});

export default app;
