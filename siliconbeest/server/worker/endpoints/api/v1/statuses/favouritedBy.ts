import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { env } from 'cloudflare:workers';
import { parsePaginationParams, buildPaginationQuery, buildLinkHeader } from '../../../../utils/pagination';
import { serializeAccount } from '../../../../utils/mastodonSerializer';
import type { AccountRow } from '../../../../types/db';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import {
  assertStatusViewable,
  buildAccountInteractionListSqlPredicate,
} from '../../../../services/permissions';

type HonoEnv = { Variables: AppVariables };

type FavouriteParticipantRow = AccountRow & {
  fav_id: string;
};

const app = new Hono<HonoEnv>();

app.get('/:id/favourited_by', authRequired, requireScope('read:statuses'), async (c) => {
  const statusId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;
  const domain = env.INSTANCE_DOMAIN;

  await assertStatusViewable(statusId, currentAccountId);

  const query = c.req.query();
  const pagination = parsePaginationParams({
    max_id: query.max_id,
    since_id: query.since_id,
    min_id: query.min_id,
    limit: query.limit,
  });

  const pag = buildPaginationQuery(pagination, 'f.id');

  const conditions = ['f.status_id = ?'];
  const params: (string | number)[] = [statusId];
  const accountPermission = buildAccountInteractionListSqlPredicate(
    'account',
    currentAccountId,
    new Date().toISOString(),
  );
  conditions.push(accountPermission.sql);
  params.push(...accountPermission.bindings);

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
  params.push(pag.limitValue + 1);

  const { results: fetchedResults } = await env.DB.prepare(sql).bind(...params).all<FavouriteParticipantRow>();
  const hasAdditionalPage = fetchedResults.length > pagination.limit;
  const results = hasAdditionalPage
    ? fetchedResults.slice(0, pagination.limit)
    : fetchedResults;

  const accounts = results.map((row) => serializeAccount(row, { instanceDomain: domain }));
  const itemsForLink = results.map((row) => ({ id: row.fav_id }));
  if (pagination.minId) {
    accounts.reverse();
    itemsForLink.reverse();
  }

  const baseUrl = `https://${domain}/api/v1/statuses/${statusId}/favourited_by`;
  const link = buildLinkHeader(baseUrl, itemsForLink, pagination.limit, {
    includeNext: pagination.minId ? true : hasAdditionalPage,
    includePrev: pagination.minId ? hasAdditionalPage : true,
  });
  if (link) c.header('Link', link);

  return c.json(accounts);
});

export default app;
