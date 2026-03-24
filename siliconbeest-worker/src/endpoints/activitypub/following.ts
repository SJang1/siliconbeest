import { Hono } from 'hono';
import type { Env, AppVariables } from '../../env';

const PAGE_SIZE = 40;

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get('/:username/following', async (c) => {
  const username = c.req.param('username');
  const domain = c.env.INSTANCE_DOMAIN;

  const account = await c.env.DB.prepare(`
    SELECT id, following_count FROM accounts
    WHERE username = ?1 AND domain IS NULL
    LIMIT 1
  `).bind(username).first<{ id: string; following_count: number }>();

  if (!account) {
    return c.json({ error: 'Record not found' }, 404);
  }

  const actorUri = `https://${domain}/users/${username}`;
  const collectionUri = `${actorUri}/following`;
  const page = c.req.query('page');

  // Without ?page: return the OrderedCollection summary
  if (!page) {
    return c.json({
      '@context': ['https://www.w3.org/ns/activitystreams'],
      id: collectionUri,
      type: 'OrderedCollection',
      totalItems: account.following_count,
      first: `${collectionUri}?page=1`,
    }, 200, {
      'Content-Type': 'application/activity+json; charset=utf-8',
      'Vary': 'Accept',
    });
  }

  // With ?page: return an OrderedCollectionPage
  const cursor = c.req.query('cursor');

  const conditions: string[] = [
    'f.account_id = ?1',
  ];
  const binds: (string | number)[] = [account.id];

  if (cursor) {
    conditions.push('f.id < ?2');
    binds.push(cursor);
  }

  const sql = `
    SELECT f.id AS follow_id, a.uri
    FROM follows f
    JOIN accounts a ON a.id = f.target_account_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY f.id DESC
    LIMIT ?${binds.length + 1}
  `;
  binds.push(PAGE_SIZE + 1);

  const { results } = await c.env.DB.prepare(sql).bind(...binds).all<{
    follow_id: string;
    uri: string;
  }>();

  const rows = results ?? [];
  const hasNext = rows.length > PAGE_SIZE;
  const items = hasNext ? rows.slice(0, PAGE_SIZE) : rows;

  const pageObj: Record<string, unknown> = {
    '@context': ['https://www.w3.org/ns/activitystreams'],
    id: cursor
      ? `${collectionUri}?page=true&cursor=${cursor}`
      : `${collectionUri}?page=1`,
    type: 'OrderedCollectionPage',
    totalItems: account.following_count,
    partOf: collectionUri,
    orderedItems: items.map((r) => r.uri),
  };

  if (hasNext) {
    const lastId = items[items.length - 1].follow_id;
    pageObj.next = `${collectionUri}?page=true&cursor=${lastId}`;
  }

  if (cursor) {
    pageObj.prev = `${collectionUri}?page=1`;
  }

  return c.json(pageObj, 200, {
    'Content-Type': 'application/activity+json; charset=utf-8',
    'Vary': 'Accept',
  });
});

export default app;
