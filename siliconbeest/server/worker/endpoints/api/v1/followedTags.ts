import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../env';
import { authRequired } from '../../../middleware/auth';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

interface TagFollowRow {
  follow_id: string;
  name: string;
}

const app = new Hono<HonoEnv>();

// GET /api/v1/followed_tags — list hashtags the user follows
app.get('/', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const domain = c.env.INSTANCE_DOMAIN;

  const limit = Math.min(parseInt(c.req.query('limit') || '100', 10) || 100, 200);
  const maxId = c.req.query('max_id');
  const sinceId = c.req.query('since_id');

  const conditions = ['tf.account_id = ?1'];
  const binds: (string | number)[] = [currentAccount.id];

  if (maxId) {
    conditions.push('tf.id < ?2');
    binds.push(maxId);
  } else if (sinceId) {
    conditions.push('tf.id > ?2');
    binds.push(sinceId);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT tf.id AS follow_id, t.name
     FROM tag_follows tf
     JOIN tags t ON t.id = tf.tag_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY tf.id DESC
     LIMIT ?${binds.length + 1}`,
  )
    .bind(...binds, limit + 1)
    .all<TagFollowRow>();

  const rows = results ?? [];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  const tags = items.map((row) => ({
    name: row.name,
    url: `https://${domain}/tags/${row.name}`,
    history: [],
    following: true,
  }));

  const headers = new Headers();
  if (items.length > 0) {
    const linkParts: string[] = [];
    if (hasMore) {
      linkParts.push(
        `<https://${domain}/api/v1/followed_tags?max_id=${items[items.length - 1].follow_id}&limit=${limit}>; rel="next"`,
      );
    }
    linkParts.push(
      `<https://${domain}/api/v1/followed_tags?since_id=${items[0].follow_id}&limit=${limit}>; rel="prev"`,
    );
    headers.set('Link', linkParts.join(', '));
  }

  return c.newResponse(JSON.stringify(tags), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...Object.fromEntries(headers) },
  });
});

export default app;
