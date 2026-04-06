import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../../types';
import { AppError } from '../../../../middleware/errorHandler';
import { parsePaginationParams, buildPaginationQuery, buildLinkHeader } from '../../../../utils/pagination';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.get('/:id/followers', async (c) => {
  const accountId = c.req.param('id');
  const domain = env.INSTANCE_DOMAIN;

  const account = await env.DB.prepare('SELECT id FROM accounts WHERE id = ?1').bind(accountId).first();
  if (!account) throw new AppError(404, 'Record not found');

  const query = c.req.query();
  const pagination = parsePaginationParams({
    max_id: query.max_id,
    since_id: query.since_id,
    min_id: query.min_id,
    limit: query.limit,
  });

  const pag = buildPaginationQuery(pagination, 'f.id');

  const conditions = ['f.target_account_id = ?'];
  const params: unknown[] = [accountId];

  if (pag.whereClause) {
    conditions.push(pag.whereClause);
    params.push(...pag.params);
  }

  const sql = `
    SELECT f.id AS follow_id, a.*
    FROM follows f
    JOIN accounts a ON a.id = f.account_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${pag.orderClause}
    LIMIT ?
  `;
  params.push(pag.limitValue);

  const { results } = await env.DB.prepare(sql).bind(...params).all();

  const accounts = (results as Record<string, unknown>[]).map((row) => {
    const acct = row.domain ? `${row.username}@${row.domain}` : (row.username as string);
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
      emojis: [],
      fields: [],
    };
  });

  // Use follow_id for pagination Link header
  const itemsForLink = (results as Record<string, unknown>[]).map((r) => ({ id: r.follow_id as string }));
  if (pagination.minId) {
    accounts.reverse();
    itemsForLink.reverse();
  }

  const baseUrl = `https://${domain}/api/v1/accounts/${accountId}/followers`;
  const link = buildLinkHeader(baseUrl, itemsForLink, pagination.limit);
  if (link) c.header('Link', link);

  return c.json(accounts);
});

export default app;
