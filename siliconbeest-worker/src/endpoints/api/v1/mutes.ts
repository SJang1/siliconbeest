import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../env';
import { authRequired } from '../../../middleware/auth';
import { parsePaginationParams, buildPaginationQuery, buildLinkHeader } from '../../../utils/pagination';
import { serializeAccount } from '../../../utils/mastodonSerializer';
import type { AccountRow } from '../../../types/db';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get('/', authRequired, async (c) => {
  const account = c.get('currentAccount')!;

  const pag = parsePaginationParams({
    max_id: c.req.query('max_id'),
    since_id: c.req.query('since_id'),
    min_id: c.req.query('min_id'),
    limit: c.req.query('limit'),
  });

  const { whereClause, orderClause, limitValue, params } = buildPaginationQuery(pag, 'm.id');

  const conditions: string[] = ['m.account_id = ?'];
  const binds: (string | number)[] = [account.id];

  if (whereClause) {
    conditions.push(whereClause);
    binds.push(...params);
  }

  const sql = `
    SELECT m.id AS m_id, a.*
    FROM mutes m
    JOIN accounts a ON a.id = m.target_account_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderClause}
    LIMIT ?
  `;
  binds.push(limitValue);

  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();

  // Build link header using mute row IDs
  const paginationItems = (results ?? []).map((row: any) => ({ id: row.m_id as string }));
  if (pag.minId) paginationItems.reverse();

  const baseUrl = `https://${c.env.INSTANCE_DOMAIN}/api/v1/mutes`;
  const link = buildLinkHeader(baseUrl, paginationItems, limitValue);
  const headers: Record<string, string> = {};
  if (link) headers['Link'] = link;

  // Restore actual account IDs in the response
  const serialized = (results as any[]).map((row: any) => {
    // In lazy-load model, account emojis are not pre-fetched - they render on-demand
    return serializeAccount(row as AccountRow, { emojis: [], instanceDomain: c.env.INSTANCE_DOMAIN });
  });
  if (pag.minId) serialized.reverse();

  return c.json(serialized, 200, headers);
});

export default app;
