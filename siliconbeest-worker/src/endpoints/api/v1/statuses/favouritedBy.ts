import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';
import { parsePaginationParams, buildPaginationQuery, buildLinkHeader } from '../../../../utils/pagination';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.get('/:id/favourited_by', async (c) => {
  const statusId = c.req.param('id');
  const domain = c.env.INSTANCE_DOMAIN;

  const status = await c.env.DB.prepare(
    'SELECT id FROM statuses WHERE id = ?1 AND deleted_at IS NULL',
  ).bind(statusId).first();
  if (!status) throw new AppError(404, 'Record not found');

  const query = c.req.query();
  const pagination = parsePaginationParams({
    max_id: query.max_id,
    since_id: query.since_id,
    min_id: query.min_id,
    limit: query.limit,
  });

  const pag = buildPaginationQuery(pagination, 'f.id');

  const conditions = ['f.status_id = ?'];
  const params: unknown[] = [statusId];

  if (pag.whereClause) {
    conditions.push(pag.whereClause);
    params.push(...pag.params);
  }

  const sql = `
    SELECT f.id AS fav_id, a.*
    FROM favourites f
    JOIN accounts a ON a.id = f.account_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${pag.orderClause}
    LIMIT ?
  `;
  params.push(pag.limitValue);

  const { results } = await c.env.DB.prepare(sql).bind(...params).all();

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
      avatar: (row.avatar_url as string) || '',
      avatar_static: (row.avatar_static_url as string) || '',
      header: (row.header_url as string) || '',
      header_static: (row.header_static_url as string) || '',
      followers_count: (row.followers_count as number) || 0,
      following_count: (row.following_count as number) || 0,
      statuses_count: (row.statuses_count as number) || 0,
      last_status_at: (row.last_status_at as string) || null,
      emojis: [],
      fields: [],
    };
  });

  const itemsForLink = (results as Record<string, unknown>[]).map((r) => ({ id: r.fav_id as string }));
  if (pagination.minId) {
    accounts.reverse();
    itemsForLink.reverse();
  }

  const baseUrl = `https://${domain}/api/v1/statuses/${statusId}/favourited_by`;
  const link = buildLinkHeader(baseUrl, itemsForLink, pagination.limit);
  if (link) c.header('Link', link);

  return c.json(accounts);
});

export default app;
