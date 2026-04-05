import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';
import {
  listLists,
  getList,
  createList,
  updateList,
  deleteList,
  getListMembers,
  addListMembers,
  removeListMembers,
} from '../../../../services/list';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

// ---------------------------------------------------------------------------
// GET /api/v1/lists — list all lists
// ---------------------------------------------------------------------------

app.get('/', authRequired, requireScope('read:lists'), async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const result = await listLists(c.env.DB, currentAccount.id);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// POST /api/v1/lists — create list
// ---------------------------------------------------------------------------

app.post('/', authRequired, requireScope('write:lists'), async (c) => {
  const currentAccount = c.get('currentAccount')!;

  let body: { title?: string; replies_policy?: string; exclusive?: boolean };
  try {
    body = await c.req.json();
  } catch {
    throw new AppError(422, 'Validation failed', 'Unable to parse request body');
  }

  if (!body.title || !body.title.trim()) {
    throw new AppError(422, 'Validation failed', 'title is required');
  }

  const result = await createList(c.env.DB, currentAccount.id, body.title.trim(), body.replies_policy, body.exclusive);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// GET /api/v1/lists/:id — get single list
// ---------------------------------------------------------------------------

app.get('/:id', authRequired, requireScope('read:lists'), async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const listId = c.req.param('id');
  const result = await getList(c.env.DB, listId, currentAccount.id);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// PUT /api/v1/lists/:id — update
// ---------------------------------------------------------------------------

app.put('/:id', authRequired, requireScope('write:lists'), async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const listId = c.req.param('id');

  let body: { title?: string; replies_policy?: string; exclusive?: boolean };
  try {
    body = await c.req.json();
  } catch {
    throw new AppError(422, 'Validation failed', 'Unable to parse request body');
  }

  const result = await updateList(c.env.DB, listId, currentAccount.id, body);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/lists/:id — delete
// ---------------------------------------------------------------------------

app.delete('/:id', authRequired, requireScope('write:lists'), async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const listId = c.req.param('id');
  await deleteList(c.env.DB, listId, currentAccount.id);
  return c.json({}, 200);
});

// ---------------------------------------------------------------------------
// GET /api/v1/lists/:id/accounts — list members
// ---------------------------------------------------------------------------

app.get('/:id/accounts', authRequired, requireScope('read:lists'), async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const listId = c.req.param('id');
  const result = await getListMembers(c.env.DB, listId, currentAccount.id, c.env.INSTANCE_DOMAIN);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// POST /api/v1/lists/:id/accounts — add members
// ---------------------------------------------------------------------------

app.post('/:id/accounts', authRequired, requireScope('write:lists'), async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const listId = c.req.param('id');

  let body: { account_ids?: string[] };
  try {
    body = await c.req.json();
  } catch {
    throw new AppError(422, 'Validation failed', 'Unable to parse request body');
  }

  const accountIds = body.account_ids || [];
  if (accountIds.length === 0) {
    throw new AppError(422, 'Validation failed', 'account_ids is required');
  }

  await addListMembers(c.env.DB, listId, currentAccount.id, accountIds);
  return c.json({}, 200);
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/lists/:id/accounts — remove members
// ---------------------------------------------------------------------------

app.delete('/:id/accounts', authRequired, requireScope('write:lists'), async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const listId = c.req.param('id');

  let body: { account_ids?: string[] };
  try {
    body = await c.req.json();
  } catch {
    throw new AppError(422, 'Validation failed', 'Unable to parse request body');
  }

  const accountIds = body.account_ids || [];
  if (accountIds.length === 0) {
    throw new AppError(422, 'Validation failed', 'account_ids is required');
  }

  await removeListMembers(c.env.DB, listId, currentAccount.id, accountIds);
  return c.json({}, 200);
});

export default app;
