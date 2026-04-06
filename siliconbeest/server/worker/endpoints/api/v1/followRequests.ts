import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../types';
import { authRequired } from '../../../middleware/auth';
import { requireScope } from '../../../middleware/scopeCheck';
import { generateUlid } from '../../../utils/ulid';
import { parsePaginationParams, buildPaginationQuery, buildLinkHeader } from '../../../utils/pagination';
import { serializeAccount } from '../../../utils/mastodonSerializer';
import { acceptFollowRequest, rejectFollowRequest } from '../../../services/account';
import { sendToRecipient } from '../../../federation/helpers/send';
import { Accept, Reject, Follow } from '@fedify/fedify/vocab';
import type { AccountRow } from '../../../types/db';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

// GET /api/v1/follow_requests — list pending follow requests
app.get('/', authRequired, requireScope('read:follows'), async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const domain = env.INSTANCE_DOMAIN;

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

  const { results } = await env.DB.prepare(sql).bind(...binds).all();

  const accounts = (results ?? []).map((row: any) => {
    return serializeAccount(row as AccountRow, { instanceDomain: env.INSTANCE_DOMAIN });
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
  const domain = env.INSTANCE_DOMAIN;
  const requestAccountId = c.req.param('id');

  const { followRequest: fr } = await acceptFollowRequest(
    domain, requestAccountId, currentAccount.id,
  );

  // Create follow notification for the requester (they now have a new follower relationship accepted)
  await env.QUEUE_INTERNAL.send({
    type: 'create_notification',
    recipientAccountId: requestAccountId,
    senderAccountId: currentAccount.id,
    notificationType: 'follow',
  });

  // AP: Send Accept(Follow) to the remote server
  const remoteAccount = await env.DB.prepare(
    'SELECT uri, inbox_url, shared_inbox_url, domain FROM accounts WHERE id = ?1',
  ).bind(requestAccountId).first<{ uri: string; inbox_url: string | null; shared_inbox_url: string | null; domain: string | null }>();

  if (remoteAccount?.domain) {
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
    await sendToRecipient(fed, currentAccount.username, remoteAccount.uri, accept);
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

  const { followRequest: fr } = await rejectFollowRequest(
    requestAccountId, currentAccount.id,
  );

  // AP: Send Reject(Follow) to the remote server
  const remoteAccount2 = await env.DB.prepare(
    'SELECT uri, inbox_url, shared_inbox_url, domain FROM accounts WHERE id = ?1',
  ).bind(requestAccountId).first<{ uri: string; inbox_url: string | null; shared_inbox_url: string | null; domain: string | null }>();

  if (remoteAccount2?.domain) {
    const domain = env.INSTANCE_DOMAIN;
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
    await sendToRecipient(fed, currentAccount.username, remoteAccount2.uri, reject);
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
