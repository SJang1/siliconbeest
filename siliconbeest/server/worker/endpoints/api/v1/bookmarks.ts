import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../types';
import { authRequired } from '../../../middleware/auth';
import { requireScope } from '../../../middleware/scopeCheck';
import { parsePaginationParams, buildPaginationQuery, buildLinkHeader } from '../../../utils/pagination';
import { serializeAccount, serializeStatus } from '../../../utils/mastodonSerializer';
import { enrichStatuses } from '../../../utils/statusEnrichment';
import type { AccountRow, StatusRow } from '../../../types/db';

interface BookmarkJoinRow extends StatusRow {
  b_id: string;
  a_id: string;
  a_username: string;
  a_domain: string | null;
  a_display_name: string;
  a_note: string;
  a_uri: string;
  a_url: string | null;
  a_avatar_url: string;
  a_avatar_static_url: string;
  a_header_url: string;
  a_header_static_url: string;
  a_locked: number;
  a_bot: number;
  a_discoverable: number | null;
  a_statuses_count: number;
  a_followers_count: number;
  a_following_count: number;
  a_last_status_at: string | null;
  a_created_at: string;
  a_suspended_at: string | null;
  a_memorial: number;
  a_moved_to_account_id: string | null;
  a_emoji_tags: string | null;
}

const app = new Hono<{ Variables: AppVariables }>();

app.get('/', authRequired, requireScope('read:bookmarks'), async (c) => {
  const account = c.get('currentAccount')!;

  const pag = parsePaginationParams({
    max_id: c.req.query('max_id'),
    since_id: c.req.query('since_id'),
    min_id: c.req.query('min_id'),
    limit: c.req.query('limit'),
  });

  const { whereClause, orderClause, limitValue, params } = buildPaginationQuery(pag, 'b.id');

  const conditions: string[] = ['b.account_id = ?'];
  const binds: (string | number)[] = [account.id];

  if (whereClause) {
    conditions.push(whereClause);
    binds.push(...params);
  }

  const sql = `
    SELECT b.id AS b_id, s.*, a.id AS a_id, a.username AS a_username, a.domain AS a_domain,
           a.display_name AS a_display_name, a.note AS a_note, a.uri AS a_uri,
           a.url AS a_url, a.avatar_url AS a_avatar_url, a.avatar_static_url AS a_avatar_static_url,
           a.header_url AS a_header_url, a.header_static_url AS a_header_static_url,
           a.locked AS a_locked, a.bot AS a_bot, a.discoverable AS a_discoverable,
           a.statuses_count AS a_statuses_count, a.followers_count AS a_followers_count,
           a.following_count AS a_following_count, a.last_status_at AS a_last_status_at,
           a.created_at AS a_created_at, a.suspended_at AS a_suspended_at,
           a.memorial AS a_memorial, a.moved_to_account_id AS a_moved_to_account_id,
           a.emoji_tags AS a_emoji_tags
    FROM bookmarks b
    JOIN statuses s ON s.id = b.status_id
    JOIN accounts a ON a.id = s.account_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderClause}
    LIMIT ?
  `;
  binds.push(limitValue);

  const { results } = await env.DB.prepare(sql).bind(...binds).all<BookmarkJoinRow>();

  const statusIds = (results ?? []).map((r) => r.id);
  const enrichments = await enrichStatuses(env.INSTANCE_DOMAIN, statusIds, account.id, env.CACHE);

  const statuses = (results ?? []).map((row) => {
    const accountRow: AccountRow = {
      id: row.a_id, username: row.a_username, domain: row.a_domain,
      display_name: row.a_display_name, note: row.a_note, uri: row.a_uri,
      url: row.a_url, avatar_url: row.a_avatar_url, avatar_static_url: row.a_avatar_static_url,
      header_url: row.a_header_url, header_static_url: row.a_header_static_url,
      locked: row.a_locked, bot: row.a_bot, discoverable: row.a_discoverable,
      manually_approves_followers: 0, statuses_count: row.a_statuses_count,
      followers_count: row.a_followers_count, following_count: row.a_following_count,
      last_status_at: row.a_last_status_at, created_at: row.a_created_at,
      updated_at: row.a_created_at, suspended_at: row.a_suspended_at,
      silenced_at: null, memorial: row.a_memorial, moved_to_account_id: row.a_moved_to_account_id,
      emoji_tags: row.a_emoji_tags || null,
    };
    const e = enrichments.get(row.id);
    const status = serializeStatus(row, {
      account: serializeAccount(accountRow, { instanceDomain: env.INSTANCE_DOMAIN }),
      bookmarked: true,
      mediaAttachments: e?.mediaAttachments,
      mentions: e?.mentions,
      favourited: e?.favourited,
      card: e?.card, poll: e?.poll,
      emojis: e?.emojis,
    });
    const statusWithPagination = status as typeof status & { _pagination_id: string };
    statusWithPagination._pagination_id = row.b_id;
    return statusWithPagination;
  });

  if (pag.minId) statuses.reverse();

  const baseUrl = `https://${env.INSTANCE_DOMAIN}/api/v1/bookmarks`;
  const link = buildLinkHeader(baseUrl, statuses, limitValue);
  const headers: Record<string, string> = {};
  if (link) headers['Link'] = link;

  return c.json(statuses, 200, headers);
});

export default app;
