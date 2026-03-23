import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authOptional } from '../../../../middleware/auth';
import { parsePaginationParams, buildPaginationQuery, buildLinkHeader } from '../../../../utils/pagination';
import { serializeAccount, serializeStatus } from '../../../../utils/mastodonSerializer';
import type { AccountRow, StatusRow } from '../../../../types/db';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get('/:tag', authOptional, async (c) => {
  const tagName = c.req.param('tag').toLowerCase();

  const pag = parsePaginationParams({
    max_id: c.req.query('max_id'),
    since_id: c.req.query('since_id'),
    min_id: c.req.query('min_id'),
    limit: c.req.query('limit'),
  });

  const { whereClause, orderClause, limitValue, params } = buildPaginationQuery(pag, 's.id');

  const conditions: string[] = [
    `t.name = ?`,
    `s.visibility = 'public'`,
    `s.deleted_at IS NULL`,
  ];
  const binds: (string | number)[] = [tagName];

  if (whereClause) {
    conditions.push(whereClause);
    binds.push(...params);
  }

  const local = c.req.query('local') === 'true';
  if (local) {
    conditions.push('s.local = 1');
  }

  const onlyMedia = c.req.query('only_media') === 'true';
  if (onlyMedia) {
    conditions.push('EXISTS (SELECT 1 FROM media_attachments ma WHERE ma.status_id = s.id)');
  }

  const sql = `
    SELECT s.*, a.id AS a_id, a.username AS a_username, a.domain AS a_domain,
           a.display_name AS a_display_name, a.note AS a_note, a.uri AS a_uri,
           a.url AS a_url, a.avatar_url AS a_avatar_url, a.avatar_static_url AS a_avatar_static_url,
           a.header_url AS a_header_url, a.header_static_url AS a_header_static_url,
           a.locked AS a_locked, a.bot AS a_bot, a.discoverable AS a_discoverable,
           a.statuses_count AS a_statuses_count, a.followers_count AS a_followers_count,
           a.following_count AS a_following_count, a.last_status_at AS a_last_status_at,
           a.created_at AS a_created_at, a.suspended_at AS a_suspended_at,
           a.memorial AS a_memorial, a.moved_to_account_id AS a_moved_to_account_id
    FROM status_tags st
    JOIN tags t ON t.id = st.tag_id
    JOIN statuses s ON s.id = st.status_id
    JOIN accounts a ON a.id = s.account_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderClause}
    LIMIT ?
  `;
  binds.push(limitValue);

  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();

  const statuses = (results ?? []).map((row: any) => {
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
    };
    return serializeStatus(row as StatusRow, { account: serializeAccount(accountRow) });
  });

  if (pag.minId) statuses.reverse();

  const baseUrl = `https://${c.env.INSTANCE_DOMAIN}/api/v1/timelines/tag/${encodeURIComponent(tagName)}`;
  const link = buildLinkHeader(baseUrl, statuses, limitValue);
  const headers: Record<string, string> = {};
  if (link) headers['Link'] = link;

  return c.json(statuses, 200, headers);
});

export default app;
