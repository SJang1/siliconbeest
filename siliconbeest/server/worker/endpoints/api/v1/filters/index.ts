import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';
import { generateUlid } from '../../../../utils/ulid';
import { serializeFilter } from '../../../../utils/mastodonSerializer';
import type { FilterRow } from '../../../../types/db';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const VALID_CONTEXTS = ['home', 'notifications', 'public', 'thread', 'account'];
const VALID_ACTIONS = ['warn', 'hide'];

const app = new Hono<HonoEnv>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchFilterWithKeywords(db: D1Database, filterId: string) {
  const filter = await db
    .prepare('SELECT * FROM filters WHERE id = ?1')
    .bind(filterId)
    .first<FilterRow>();

  if (!filter) return null;

  const { results: keywords } = await db
    .prepare('SELECT id, keyword, whole_word FROM filter_keywords WHERE filter_id = ?1')
    .bind(filterId)
    .all();

  const { results: statuses } = await db
    .prepare('SELECT id, status_id FROM filter_statuses WHERE filter_id = ?1')
    .bind(filterId)
    .all();

  return serializeFilter(filter, {
    keywords: (keywords ?? []) as Array<{ id: string; keyword: string; whole_word: number }>,
    statuses: (statuses ?? []) as Array<{ id: string; status_id: string }>,
  });
}

// ---------------------------------------------------------------------------
// GET /api/v2/filters — list all filters
// ---------------------------------------------------------------------------

app.get('/', authRequired, requireScope('read:filters'), async (c) => {
  const currentUser = c.get('currentUser')!;

  const { results: filters } = await c.env.DB.prepare(
    'SELECT * FROM filters WHERE user_id = ?1 ORDER BY created_at DESC',
  )
    .bind(currentUser.id)
    .all();

  const serialized = [];
  for (const row of filters ?? []) {
    const filter = await fetchFilterWithKeywords(c.env.DB, row.id as string);
    if (filter) serialized.push(filter);
  }

  return c.json(serialized);
});

// ---------------------------------------------------------------------------
// POST /api/v2/filters — create filter
// ---------------------------------------------------------------------------

app.post('/', authRequired, requireScope('write:filters'), async (c) => {
  const currentUser = c.get('currentUser')!;

  let body: {
    title?: string;
    context?: string[];
    filter_action?: string;
    expires_in?: number;
    keywords_attributes?: Array<{ keyword: string; whole_word?: boolean }>;
  };
  try {
    body = await c.req.json();
  } catch {
    throw new AppError(422, 'Validation failed', 'Unable to parse request body');
  }

  if (!body.title) {
    throw new AppError(422, 'Validation failed', 'title is required');
  }

  if (!body.context || !Array.isArray(body.context) || body.context.length === 0) {
    throw new AppError(422, 'Validation failed', 'context is required');
  }

  for (const ctx of body.context) {
    if (!VALID_CONTEXTS.includes(ctx)) {
      throw new AppError(422, 'Validation failed', `Invalid context: ${ctx}`);
    }
  }

  const filterAction = body.filter_action || 'warn';
  if (!VALID_ACTIONS.includes(filterAction)) {
    throw new AppError(422, 'Validation failed', 'Invalid filter_action');
  }

  const filterId = generateUlid();
  const now = new Date().toISOString();
  let expiresAt: string | null = null;

  if (body.expires_in && body.expires_in > 0) {
    expiresAt = new Date(Date.now() + body.expires_in * 1000).toISOString();
  }

  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO filters (id, user_id, title, context, action, expires_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
    ).bind(filterId, currentUser.id, body.title, JSON.stringify(body.context), filterAction, expiresAt, now),
  ];

  // Add keywords if provided
  if (body.keywords_attributes) {
    for (const kw of body.keywords_attributes) {
      const kwId = generateUlid();
      stmts.push(
        c.env.DB.prepare(
          'INSERT INTO filter_keywords (id, filter_id, keyword, whole_word, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)',
        ).bind(kwId, filterId, kw.keyword, kw.whole_word ? 1 : 0, now),
      );
    }
  }

  await c.env.DB.batch(stmts);

  const result = await fetchFilterWithKeywords(c.env.DB, filterId);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// GET /api/v2/filters/:id — single filter
// ---------------------------------------------------------------------------

app.get('/:id', authRequired, requireScope('read:filters'), async (c) => {
  const currentUser = c.get('currentUser')!;
  const filterId = c.req.param('id');

  const filter = await c.env.DB.prepare(
    'SELECT * FROM filters WHERE id = ?1 AND user_id = ?2',
  )
    .bind(filterId, currentUser.id)
    .first<FilterRow>();

  if (!filter) {
    throw new AppError(404, 'Record not found');
  }

  const result = await fetchFilterWithKeywords(c.env.DB, filterId);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// PUT /api/v2/filters/:id — update
// ---------------------------------------------------------------------------

app.put('/:id', authRequired, requireScope('write:filters'), async (c) => {
  const currentUser = c.get('currentUser')!;
  const filterId = c.req.param('id');

  const existing = await c.env.DB.prepare(
    'SELECT * FROM filters WHERE id = ?1 AND user_id = ?2',
  )
    .bind(filterId, currentUser.id)
    .first<FilterRow>();

  if (!existing) {
    throw new AppError(404, 'Record not found');
  }

  let body: {
    title?: string;
    context?: string[];
    filter_action?: string;
    expires_in?: number;
    keywords_attributes?: Array<{ id?: string; keyword?: string; whole_word?: boolean; _destroy?: boolean }>;
  };
  try {
    body = await c.req.json();
  } catch {
    throw new AppError(422, 'Validation failed', 'Unable to parse request body');
  }

  const now = new Date().toISOString();
  const title = body.title ?? existing.title;
  const context = body.context ? JSON.stringify(body.context) : existing.context;
  const action = body.filter_action ?? existing.action;
  let expiresAt = existing.expires_at;

  if (body.expires_in !== undefined) {
    expiresAt =
      body.expires_in && body.expires_in > 0
        ? new Date(Date.now() + body.expires_in * 1000).toISOString()
        : null;
  }

  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(
      'UPDATE filters SET title = ?1, context = ?2, action = ?3, expires_at = ?4, updated_at = ?5 WHERE id = ?6',
    ).bind(title, context, action, expiresAt, now, filterId),
  ];

  // Handle keyword updates
  if (body.keywords_attributes) {
    for (const kw of body.keywords_attributes) {
      if (kw._destroy && kw.id) {
        stmts.push(
          c.env.DB.prepare('DELETE FROM filter_keywords WHERE id = ?1 AND filter_id = ?2').bind(kw.id, filterId),
        );
      } else if (kw.id) {
        // Update existing keyword
        if (kw.keyword !== undefined) {
          stmts.push(
            c.env.DB.prepare(
              'UPDATE filter_keywords SET keyword = ?1, whole_word = ?2, updated_at = ?3 WHERE id = ?4 AND filter_id = ?5',
            ).bind(kw.keyword, kw.whole_word ? 1 : 0, now, kw.id, filterId),
          );
        }
      } else if (kw.keyword) {
        // New keyword
        const kwId = generateUlid();
        stmts.push(
          c.env.DB.prepare(
            'INSERT INTO filter_keywords (id, filter_id, keyword, whole_word, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)',
          ).bind(kwId, filterId, kw.keyword, kw.whole_word ? 1 : 0, now),
        );
      }
    }
  }

  await c.env.DB.batch(stmts);

  const result = await fetchFilterWithKeywords(c.env.DB, filterId);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// DELETE /api/v2/filters/:id — delete (CASCADE on keywords)
// ---------------------------------------------------------------------------

app.delete('/:id', authRequired, requireScope('write:filters'), async (c) => {
  const currentUser = c.get('currentUser')!;
  const filterId = c.req.param('id');

  const existing = await c.env.DB.prepare(
    'SELECT id FROM filters WHERE id = ?1 AND user_id = ?2',
  )
    .bind(filterId, currentUser.id)
    .first();

  if (!existing) {
    throw new AppError(404, 'Record not found');
  }

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM filter_keywords WHERE filter_id = ?1').bind(filterId),
    c.env.DB.prepare('DELETE FROM filter_statuses WHERE filter_id = ?1').bind(filterId),
    c.env.DB.prepare('DELETE FROM filters WHERE id = ?1').bind(filterId),
  ]);

  return c.json({}, 200);
});

// ---------------------------------------------------------------------------
// POST /api/v2/filters/:id/keywords — add keyword
// ---------------------------------------------------------------------------

app.post('/:id/keywords', authRequired, requireScope('write:filters'), async (c) => {
  const currentUser = c.get('currentUser')!;
  const filterId = c.req.param('id');

  const filter = await c.env.DB.prepare(
    'SELECT id FROM filters WHERE id = ?1 AND user_id = ?2',
  )
    .bind(filterId, currentUser.id)
    .first();

  if (!filter) {
    throw new AppError(404, 'Record not found');
  }

  let body: { keyword?: string; whole_word?: boolean };
  try {
    body = await c.req.json();
  } catch {
    throw new AppError(422, 'Validation failed', 'Unable to parse request body');
  }

  if (!body.keyword) {
    throw new AppError(422, 'Validation failed', 'keyword is required');
  }

  const kwId = generateUlid();
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    'INSERT INTO filter_keywords (id, filter_id, keyword, whole_word, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)',
  )
    .bind(kwId, filterId, body.keyword, body.whole_word ? 1 : 0, now)
    .run();

  return c.json({
    id: kwId,
    keyword: body.keyword,
    whole_word: !!body.whole_word,
  });
});

// ---------------------------------------------------------------------------
// GET /api/v2/filters/:id/keywords — list keywords
// ---------------------------------------------------------------------------

app.get('/:id/keywords', authRequired, requireScope('read:filters'), async (c) => {
  const currentUser = c.get('currentUser')!;
  const filterId = c.req.param('id');

  const filter = await c.env.DB.prepare(
    'SELECT id FROM filters WHERE id = ?1 AND user_id = ?2',
  )
    .bind(filterId, currentUser.id)
    .first();

  if (!filter) {
    throw new AppError(404, 'Record not found');
  }

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM filter_keywords WHERE filter_id = ?1 ORDER BY created_at ASC',
  )
    .bind(filterId)
    .all();

  const keywords = (results ?? []).map((row: any) => ({
    id: row.id as string,
    keyword: row.keyword as string,
    whole_word: !!(row.whole_word as number),
  }));

  return c.json(keywords);
});

// ---------------------------------------------------------------------------
// DELETE /api/v2/filters/:id/keywords/:keyword_id — remove keyword
// ---------------------------------------------------------------------------

app.delete('/:id/keywords/:keyword_id', authRequired, requireScope('write:filters'), async (c) => {
  const currentUser = c.get('currentUser')!;
  const filterId = c.req.param('id');
  const keywordId = c.req.param('keyword_id');

  const filter = await c.env.DB.prepare(
    'SELECT id FROM filters WHERE id = ?1 AND user_id = ?2',
  )
    .bind(filterId, currentUser.id)
    .first();

  if (!filter) {
    throw new AppError(404, 'Record not found');
  }

  const kw = await c.env.DB.prepare(
    'SELECT id FROM filter_keywords WHERE id = ?1 AND filter_id = ?2',
  )
    .bind(keywordId, filterId)
    .first();

  if (!kw) {
    throw new AppError(404, 'Record not found');
  }

  await c.env.DB.prepare('DELETE FROM filter_keywords WHERE id = ?1').bind(keywordId).run();

  return c.json({}, 200);
});

export default app;
