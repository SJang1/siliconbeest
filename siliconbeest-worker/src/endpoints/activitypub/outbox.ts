import { Hono } from 'hono';
import type { Env, AppVariables } from '../../env';
import { serializeNote } from '../../federation/noteSerializer';
import type { AccountRow, StatusRow } from '../../types/db';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get('/:username/outbox', async (c) => {
  const username = c.req.param('username');
  const domain = c.env.INSTANCE_DOMAIN;

  const account = await c.env.DB.prepare(`
    SELECT * FROM accounts
    WHERE username = ?1 AND domain IS NULL
    LIMIT 1
  `).bind(username).first<AccountRow>();

  if (!account) {
    return c.json({ error: 'Record not found' }, 404);
  }

  const actorUri = `https://${domain}/users/${username}`;
  const outboxUri = `${actorUri}/outbox`;

  // Check if this is a collection page request
  const page = c.req.query('page');
  const maxId = c.req.query('max_id');

  if (!page) {
    // Return the OrderedCollection summary
    const countRow = await c.env.DB.prepare(`
      SELECT COUNT(*) AS cnt FROM statuses
      WHERE account_id = ?1 AND visibility IN ('public', 'unlisted')
        AND deleted_at IS NULL AND reblog_of_id IS NULL
    `).bind(account.id).first<{ cnt: number }>();

    return c.json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: outboxUri,
      type: 'OrderedCollection',
      totalItems: countRow?.cnt ?? 0,
      first: `${outboxUri}?page=true`,
      last: `${outboxUri}?page=true&min_id=0`,
    }, 200, {
      'Content-Type': 'application/activity+json; charset=utf-8',
    });
  }

  // Return a page of activities
  const conditions: string[] = [
    'account_id = ?',
    `visibility IN ('public', 'unlisted')`,
    'deleted_at IS NULL',
    'reblog_of_id IS NULL',
  ];
  const binds: (string | number)[] = [account.id];

  if (maxId) {
    conditions.push('id < ?');
    binds.push(maxId);
  }

  const limit = 20;
  const sql = `
    SELECT * FROM statuses
    WHERE ${conditions.join(' AND ')}
    ORDER BY id DESC
    LIMIT ?
  `;
  binds.push(limit);

  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();
  const rows = (results ?? []) as unknown as StatusRow[];

  // Batch-fetch conversation AP URIs
  const convIds = [...new Set(rows.map((r) => r.conversation_id).filter(Boolean))] as string[];
  const convMap = new Map<string, string | null>();
  for (const cid of convIds) {
    const row = await c.env.DB.prepare('SELECT ap_uri FROM conversations WHERE id = ?1').bind(cid).first<{ ap_uri: string | null }>();
    convMap.set(cid, row?.ap_uri ?? null);
  }

  const orderedItems = rows.map((status) => {
    const conversationApUri = status.conversation_id ? convMap.get(status.conversation_id) ?? null : null;
    const note = serializeNote(status, account, domain, { conversationApUri });
    return {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${status.uri}/activity`,
      type: 'Create',
      actor: actorUri,
      published: status.created_at,
      to: note.to,
      cc: note.cc,
      object: note,
    };
  });

  const pageObj: Record<string, any> = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: maxId ? `${outboxUri}?page=true&max_id=${maxId}` : `${outboxUri}?page=true`,
    type: 'OrderedCollectionPage',
    partOf: outboxUri,
    orderedItems,
  };

  if (rows.length === limit) {
    const lastId = rows[rows.length - 1].id;
    pageObj.next = `${outboxUri}?page=true&max_id=${lastId}`;
  }

  return c.json(pageObj, 200, {
    'Content-Type': 'application/activity+json; charset=utf-8',
  });
});

export default app;
