import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../env';
import { authRequired } from '../../../middleware/auth';
import { AppError } from '../../../middleware/errorHandler';
import { generateUlid } from '../../../utils/ulid';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

interface FeaturedTagWithNameRow {
  id: string;
  tag_name: string;
  statuses_count: number | null;
  last_status_at: string | null;
}

interface TagRow {
  id: string;
  name: string;
}

interface SuggestionRow {
  name: string;
  cnt: number;
}

function serialize(row: FeaturedTagWithNameRow, domain: string) {
  return {
    id: row.id,
    name: row.tag_name,
    url: `https://${domain}/tags/${row.tag_name}`,
    statuses_count: row.statuses_count ?? 0,
    last_status_at: row.last_status_at || null,
  };
}

const app = new Hono<HonoEnv>();

// GET /api/v1/featured_tags — list own featured tags
app.get('/', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const domain = c.env.INSTANCE_DOMAIN;

  const { results } = await c.env.DB.prepare(
    `SELECT ft.*, t.name AS tag_name
     FROM featured_tags ft
     JOIN tags t ON t.id = ft.tag_id
     WHERE ft.account_id = ?1
     ORDER BY ft.created_at DESC`,
  )
    .bind(currentAccount.id)
    .all<FeaturedTagWithNameRow>();

  return c.json((results ?? []).map((r) => serialize(r, domain)));
});

// POST /api/v1/featured_tags — feature a tag
app.post('/', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const domain = c.env.INSTANCE_DOMAIN;
  const body = await c.req.json<{ name?: string }>();

  if (!body.name) throw new AppError(422, 'Validation failed: name is required');

  const tagName = body.name.toLowerCase().replace(/^#/, '');

  // Find or create the tag
  let tag = await c.env.DB.prepare('SELECT * FROM tags WHERE name = ?1')
    .bind(tagName)
    .first<TagRow>();

  if (!tag) {
    const tagId = generateUlid();
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      'INSERT INTO tags (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)',
    )
      .bind(tagId, tagName, now, now)
      .run();
    tag = { id: tagId, name: tagName };
  }

  // Check if already featured
  const existing = await c.env.DB.prepare(
    'SELECT id FROM featured_tags WHERE account_id = ?1 AND tag_id = ?2',
  )
    .bind(currentAccount.id, tag.id)
    .first();

  if (existing) throw new AppError(422, 'Validation failed: tag is already featured');

  // Count statuses with this tag
  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM statuses s
     JOIN status_tags st ON st.status_id = s.id
     WHERE s.account_id = ?1 AND st.tag_id = ?2 AND s.deleted_at IS NULL`,
  )
    .bind(currentAccount.id, tag.id)
    .first<{ cnt: number }>();

  const lastRow = await c.env.DB.prepare(
    `SELECT s.created_at FROM statuses s
     JOIN status_tags st ON st.status_id = s.id
     WHERE s.account_id = ?1 AND st.tag_id = ?2 AND s.deleted_at IS NULL
     ORDER BY s.created_at DESC LIMIT 1`,
  )
    .bind(currentAccount.id, tag.id)
    .first<{ created_at: string }>();

  const id = generateUlid();
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO featured_tags (id, account_id, tag_id, statuses_count, last_status_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(id, currentAccount.id, tag.id, countRow?.cnt ?? 0, lastRow?.created_at ?? null, now)
    .run();

  return c.json({
    id,
    name: tagName,
    url: `https://${domain}/tags/${tagName}`,
    statuses_count: countRow?.cnt ?? 0,
    last_status_at: lastRow?.created_at ?? null,
  });
});

// DELETE /api/v1/featured_tags/:id — unfeature a tag
app.delete('/:id', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const ftId = c.req.param('id');

  const existing = await c.env.DB.prepare(
    'SELECT id FROM featured_tags WHERE id = ?1 AND account_id = ?2',
  )
    .bind(ftId, currentAccount.id)
    .first();

  if (!existing) throw new AppError(404, 'Record not found');

  await c.env.DB.prepare('DELETE FROM featured_tags WHERE id = ?1')
    .bind(ftId)
    .run();

  return c.json({});
});

// GET /api/v1/featured_tags/suggestions — suggest tags to feature
app.get('/suggestions', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const domain = c.env.INSTANCE_DOMAIN;

  const { results } = await c.env.DB.prepare(
    `SELECT t.name, COUNT(*) AS cnt
     FROM status_tags st
     JOIN tags t ON t.id = st.tag_id
     JOIN statuses s ON s.id = st.status_id
     WHERE s.account_id = ?1 AND s.deleted_at IS NULL
       AND t.id NOT IN (SELECT tag_id FROM featured_tags WHERE account_id = ?1)
     GROUP BY t.id
     ORDER BY cnt DESC
     LIMIT 10`,
  )
    .bind(currentAccount.id)
    .all<SuggestionRow>();

  return c.json(
    (results ?? []).map((r) => ({
      name: r.name,
      url: `https://${domain}/tags/${r.name}`,
      history: [],
      following: false,
    })),
  );
});

export default app;
