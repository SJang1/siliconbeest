import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../types';
import { authRequired } from '../../../middleware/auth';
import { requireScope } from '../../../middleware/scopeCheck';
import { parsePaginationParams, buildPaginationQuery, buildLinkHeader } from '../../../utils/pagination';
import { serializeAccount } from '../../../utils/mastodonSerializer';
import type { AccountRow } from '../../../types/db';

const app = new Hono<{ Variables: AppVariables }>();

app.get('/', authRequired, requireScope('read:blocks'), async (c) => {
  const account = c.get('currentAccount')!;

  const pag = parsePaginationParams({
    max_id: c.req.query('max_id'),
    since_id: c.req.query('since_id'),
    min_id: c.req.query('min_id'),
    limit: c.req.query('limit'),
  });

  const { whereClause, orderClause, limitValue, params } = buildPaginationQuery(pag, 'bl.id');

  const conditions: string[] = ['bl.account_id = ?'];
  const binds: (string | number)[] = [account.id];

  if (whereClause) {
    conditions.push(whereClause);
    binds.push(...params);
  }

  const sql = `
    SELECT bl.id AS bl_id, a.*
    FROM blocks bl
    JOIN accounts a ON a.id = bl.target_account_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderClause}
    LIMIT ?
  `;
  binds.push(limitValue);

  const { results } = await env.DB.prepare(sql).bind(...binds).all();

  const serialized = (results ?? []).map((row: any) => {
    return serializeAccount(row as AccountRow, { instanceDomain: env.INSTANCE_DOMAIN });
  });

  if (pag.minId) serialized.reverse();

  const baseUrl = `https://${env.INSTANCE_DOMAIN}/api/v1/blocks`;
  const link = buildLinkHeader(baseUrl, serialized, limitValue);
  const headers: Record<string, string> = {};
  if (link) headers['Link'] = link;

  return c.json(serialized, 200, headers);
});

export default app;
