import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../env';
import { authRequired } from '../../../middleware/auth';
import { requireScope } from '../../../middleware/scopeCheck';
import { AppError } from '../../../middleware/errorHandler';
import { generateUlid } from '../../../utils/ulid';
import { parsePaginationParams, buildPaginationQuery, buildLinkHeader } from '../../../utils/pagination';
import { serializeAccount } from '../../../utils/mastodonSerializer';
import { sendToRecipient } from '../../../federation/helpers/send';
import { Accept, Reject, Follow } from '@fedify/fedify/vocab';
import type { AccountRow } from '../../../types/db';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

// GET /api/v1/follow_requests — list pending follow requests
app.get('/', authRequired, requireScope('read:follows'), async (c) => {
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
    ORDER BY ${orderClause}
    LIMIT ?
  `;
  binds.push(limitValue);

  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();

  const accounts = (results ?? []).map((row: any) => {
    return serializeAccount(row as AccountRow, { instanceDomain: c.env.INSTANCE_DOMAIN });
  });

  if (pag.minId) accounts.reverse();

  const baseUrl = `https://${domain}/api/v1/follow_requests`;
  const link = buildLinkHeader(baseUrl, accounts, limitValue);
  const headers: Record<string, string> = {};
  if (link) headers['Link'] = link;

  return c.json(accounts, 200, headers);
});

// POST /api/v1/follow_requests/:id/authorize — accept follow request
app.post('/:id/authorize', authRequired, requireScope('write:follows'), async (c) => {
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

  // Create follow notification for the requester (they now have a new follower relationship accepted)
  try {
    await c.env.QUEUE_INTERNAL.send({
      type: 'create_notification',
      recipientAccountId: requestAccountId,
      senderAccountId: currentAccount.id,
      notificationType: 'follow',
    });
  } catch (_) { /* don't fail */ }

  // AP: Send Accept(Follow) to the remote server
  const remoteAccount = await c.env.DB.prepare(
    'SELECT uri, inbox_url, shared_inbox_url, domain FROM accounts WHERE id = ?1',
  ).bind(requestAccountId).first<{ uri: string; inbox_url: string | null; shared_inbox_url: string | null; domain: string | null }>();

  if (remoteAccount?.domain) {
    try {
      const myUri = `https://${domain}/users/${currentAccount.username}`;
      const originalFollow = new Follow({
        id: new URL((fr.uri as string) || `https://${domain}/activities/${generateUlid()}`),
        actor: new URL(remoteAccount.uri),
        object: new URL(myUri),
      });
      const accept = new Accept({
        id: new URL(`https://${domain}/activities/${generateUlid()}`),
        actor: new URL(myUri),
        object: originalFollow,
        tos: [new URL(remoteAccount.uri)],
      });
      const fed = c.get('federation');
      await sendToRecipient(fed, c.env, currentAccount.username, remoteAccount.uri, accept);
    } catch (_) { /* don't fail the API response */ }
  }

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
app.post('/:id/reject', authRequired, requireScope('write:follows'), async (c) => {
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

  // AP: Send Reject(Follow) to the remote server
  const remoteAccount2 = await c.env.DB.prepare(
    'SELECT uri, inbox_url, shared_inbox_url, domain FROM accounts WHERE id = ?1',
  ).bind(requestAccountId).first<{ uri: string; inbox_url: string | null; shared_inbox_url: string | null; domain: string | null }>();

  if (remoteAccount2?.domain) {
    try {
      const domain = c.env.INSTANCE_DOMAIN;
      const myUri = `https://${domain}/users/${currentAccount.username}`;
      const originalFollow = new Follow({
        id: new URL((fr.uri as string) || `https://${domain}/activities/${generateUlid()}`),
        actor: new URL(remoteAccount2.uri),
        object: new URL(myUri),
      });
      const reject = new Reject({
        id: new URL(`https://${domain}/activities/${generateUlid()}`),
        actor: new URL(myUri),
        object: originalFollow,
        tos: [new URL(remoteAccount2.uri)],
      });
      const fed = c.get('federation');
      await sendToRecipient(fed, c.env, currentAccount.username, remoteAccount2.uri, reject);
    } catch (_) { /* don't fail */ }
  }

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
