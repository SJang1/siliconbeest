import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../env';
import { authRequired } from '../../../middleware/auth';
import { AppError } from '../../../middleware/errorHandler';
import { generateUlid } from '../../../utils/ulid';
import { parsePaginationParams, buildPaginationQuery, buildLinkHeader } from '../../../utils/pagination';
import { serializeAccount } from '../../../utils/mastodonSerializer';
import type { AccountRow } from '../../../types/db';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

// GET /api/v1/follow_requests — list pending follow requests
app.get('/', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const domain = c.env.INSTANCE_DOMAIN;

  const pag = parsePaginationParams({
    max_id: c.req.query('max_id'),
    since_id: c.req.query('since_id'),
    min_id: c.req.query('min_id'),
    limit: c.req.query('limit'),
  });

  const { whereClause, orderClause, limitValue, params } = buildPaginationQuery(pag, 'fr.id');

  const conditions: string[] = ['fr.target_account_id = ?'];
  const binds: (string | number)[] = [currentAccount.id];

  if (whereClause) {
    conditions.push(whereClause);
    binds.push(...params);
  }

  const sql = `
    SELECT fr.id AS fr_id, a.*
    FROM follow_requests fr
    JOIN accounts a ON a.id = fr.account_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderClause.replace('id', 'fr.id')}
    LIMIT ?
  `;
  binds.push(limitValue);

  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();

  const accounts = (results ?? []).map((row: any) => {
    const account = serializeAccount(row as AccountRow);
    account.id = row.fr_id;
    return account;
  });

  if (pag.minId) accounts.reverse();

  const baseUrl = `https://${domain}/api/v1/follow_requests`;
  const link = buildLinkHeader(baseUrl, accounts, limitValue);
  const headers: Record<string, string> = {};
  if (link) headers['Link'] = link;

  return c.json(accounts, 200, headers);
});

// POST /api/v1/follow_requests/:id/authorize — accept follow request
app.post('/:id/authorize', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const domain = c.env.INSTANCE_DOMAIN;
  const requestAccountId = c.req.param('id');

  const fr = await c.env.DB.prepare(
    'SELECT * FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2',
  )
    .bind(requestAccountId, currentAccount.id)
    .first();

  if (!fr) {
    throw new AppError(404, 'Record not found');
  }

  const now = new Date().toISOString();
  const followId = generateUlid();
  const followUri = `https://${domain}/users/${currentAccount.username}/followers/${followId}`;

  await c.env.DB.batch([
    // Create the follow
    c.env.DB.prepare(
      `INSERT INTO follows (id, account_id, target_account_id, uri, show_reblogs, notify, languages, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 1, 0, NULL, ?5, ?5)`,
    ).bind(followId, requestAccountId, currentAccount.id, followUri, now),
    // Update follower/following counts
    c.env.DB.prepare(
      'UPDATE accounts SET following_count = following_count + 1 WHERE id = ?1',
    ).bind(requestAccountId),
    c.env.DB.prepare(
      'UPDATE accounts SET followers_count = followers_count + 1 WHERE id = ?1',
    ).bind(currentAccount.id),
    // Remove the follow request
    c.env.DB.prepare(
      'DELETE FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2',
    ).bind(requestAccountId, currentAccount.id),
  ]);

  return c.json({
    id: requestAccountId,
    following: false,
    showing_reblogs: true,
    notifying: false,
    followed_by: true,
    blocking: false,
    blocked_by: false,
    muting: false,
    muting_notifications: false,
    requested: false,
    requested_by: false,
    domain_blocking: false,
    endorsed: false,
    note: '',
    languages: null,
  });
});

// POST /api/v1/follow_requests/:id/reject — reject follow request
app.post('/:id/reject', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const requestAccountId = c.req.param('id');

  const fr = await c.env.DB.prepare(
    'SELECT * FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2',
  )
    .bind(requestAccountId, currentAccount.id)
    .first();

  if (!fr) {
    throw new AppError(404, 'Record not found');
  }

  await c.env.DB.prepare(
    'DELETE FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2',
  )
    .bind(requestAccountId, currentAccount.id)
    .run();

  return c.json({
    id: requestAccountId,
    following: false,
    showing_reblogs: false,
    notifying: false,
    followed_by: false,
    blocking: false,
    blocked_by: false,
    muting: false,
    muting_notifications: false,
    requested: false,
    requested_by: false,
    domain_blocking: false,
    endorsed: false,
    note: '',
    languages: null,
  });
});

export default app;
