import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * GET /api/v1/trends/tags — Return trending tags.
 * Tags used in recent public statuses (last 7 days), grouped by tag, ordered by use count DESC.
 */
app.get('/', async (c) => {
  const limitRaw = parseInt(c.req.query('limit') ?? '10', 10);
  const limit = Math.min(Math.max(limitRaw, 1), 20);
  const offsetRaw = parseInt(c.req.query('offset') ?? '0', 10);
  const offset = Math.max(offsetRaw, 0);
  const domain = c.env.INSTANCE_DOMAIN;

  const { results } = await c.env.DB.prepare(`
    SELECT t.*, COUNT(st.tag_id) as uses
    FROM tags t
    JOIN status_tags st ON st.tag_id = t.id
    JOIN statuses s ON s.id = st.status_id
    WHERE s.created_at > datetime('now', '-7 days')
      AND s.deleted_at IS NULL
      AND s.visibility = 'public'
    GROUP BY t.id
    ORDER BY uses DESC
    LIMIT ?1 OFFSET ?2
  `).bind(limit, offset).all();

  const tags = (results ?? []).map((row: any) => {
    const uses = (row.uses as number) || 0;
    return {
      name: row.name as string,
      url: `https://${domain}/tags/${row.name}`,
      history: [
        {
          day: String(Math.floor(Date.now() / 1000 / 86400) * 86400),
          accounts: String(Math.min(uses, uses)),
          uses: String(uses),
        },
      ],
      following: false,
    };
  });

  return c.json(tags);
});

export default app;
