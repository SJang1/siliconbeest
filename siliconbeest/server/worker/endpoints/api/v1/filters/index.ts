import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';
import {
  listFilters,
  getFilter,
  createFilter,
  updateFilter,
  deleteFilter,
  addFilterKeyword,
  listFilterKeywords,
  deleteFilterKeyword,
} from '../../../../services/filter';

type HonoEnv = { Variables: AppVariables };

const VALID_CONTEXTS = ['home', 'notifications', 'public', 'thread', 'account'];
const VALID_ACTIONS = ['warn', 'hide'];

const app = new Hono<HonoEnv>();

// ---------------------------------------------------------------------------
// GET /api/v2/filters — list all filters
// ---------------------------------------------------------------------------

app.get('/', authRequired, requireScope('read:filters'), async (c) => {
  const currentUser = c.get('currentUser')!;
  const result = await listFilters(currentUser.id);
  return c.json(result);
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

  const result = await createFilter(currentUser.id, {
    title: body.title,
    context: body.context,
    filter_action: filterAction,
    expires_in: body.expires_in,
    keywords_attributes: body.keywords_attributes,
  });
  return c.json(result);
});

// ---------------------------------------------------------------------------
// GET /api/v2/filters/:id — single filter
// ---------------------------------------------------------------------------

app.get('/:id', authRequired, requireScope('read:filters'), async (c) => {
  const currentUser = c.get('currentUser')!;
  const filterId = c.req.param('id');
  const result = await getFilter(filterId, currentUser.id);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// PUT /api/v2/filters/:id — update
// ---------------------------------------------------------------------------

app.put('/:id', authRequired, requireScope('write:filters'), async (c) => {
  const currentUser = c.get('currentUser')!;
  const filterId = c.req.param('id');

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

  const result = await updateFilter(filterId, currentUser.id, body);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// DELETE /api/v2/filters/:id — delete (CASCADE on keywords)
// ---------------------------------------------------------------------------

app.delete('/:id', authRequired, requireScope('write:filters'), async (c) => {
  const currentUser = c.get('currentUser')!;
  const filterId = c.req.param('id');
  await deleteFilter(filterId, currentUser.id);
  return c.json({}, 200);
});

// ---------------------------------------------------------------------------
// POST /api/v2/filters/:id/keywords — add keyword
// ---------------------------------------------------------------------------

app.post('/:id/keywords', authRequired, requireScope('write:filters'), async (c) => {
  const currentUser = c.get('currentUser')!;
  const filterId = c.req.param('id');

  let body: { keyword?: string; whole_word?: boolean };
  try {
    body = await c.req.json();
  } catch {
    throw new AppError(422, 'Validation failed', 'Unable to parse request body');
  }

  if (!body.keyword) {
    throw new AppError(422, 'Validation failed', 'keyword is required');
  }

  const result = await addFilterKeyword(filterId, currentUser.id, body.keyword, !!body.whole_word);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// GET /api/v2/filters/:id/keywords — list keywords
// ---------------------------------------------------------------------------

app.get('/:id/keywords', authRequired, requireScope('read:filters'), async (c) => {
  const currentUser = c.get('currentUser')!;
  const filterId = c.req.param('id');
  const result = await listFilterKeywords(filterId, currentUser.id);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// DELETE /api/v2/filters/:id/keywords/:keyword_id — remove keyword
// ---------------------------------------------------------------------------

app.delete('/:id/keywords/:keyword_id', authRequired, requireScope('write:filters'), async (c) => {
  const currentUser = c.get('currentUser')!;
  const filterId = c.req.param('id');
  const keywordId = c.req.param('keyword_id');
  await deleteFilterKeyword(filterId, keywordId, currentUser.id);
  return c.json({}, 200);
});

export default app;
