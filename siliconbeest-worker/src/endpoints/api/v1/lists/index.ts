import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';
import { generateUlid } from '../../../../utils/ulid';
import { serializeList, serializeAccount } from '../../../../utils/mastodonSerializer';
import type { ListRow, AccountRow } from '../../../../types/db';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

// ---------------------------------------------------------------------------
// GET /api/v1/lists — list all lists
// ---------------------------------------------------------------------------

app.get('/', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM lists WHERE account_id = ?1 ORDER BY created_at ASC',
  )
    .bind(currentAccount.id)
    .all();

  const lists = (results ?? []).map((row: any) => serializeList(row as ListRow));

  return c.json(lists);
});

// ---------------------------------------------------------------------------
// POST /api/v1/lists — create list
// ---------------------------------------------------------------------------

app.post('/', authRequired, async (c) => {
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

  const listId = generateUlid();
  const now = new Date().toISOString();
  const repliesPolicy = body.replies_policy || 'list';
  const exclusive = body.exclusive ? 1 : 0;

  await c.env.DB.prepare(
    `INSERT INTO lists (id, account_id, title, replies_policy, exclusive, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
  )
    .bind(listId, currentAccount.id, body.title.trim(), repliesPolicy, exclusive, now)
    .run();

  return c.json({
    id: listId,
    title: body.title.trim(),
    replies_policy: repliesPolicy,
    exclusive: !!exclusive,
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/lists/:id — get single list
// ---------------------------------------------------------------------------

app.get('/:id', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const listId = c.req.param('id');

  const row = await c.env.DB.prepare(
    'SELECT * FROM lists WHERE id = ?1 AND account_id = ?2',
  )
    .bind(listId, currentAccount.id)
    .first<ListRow>();

  if (!row) {
    throw new AppError(404, 'Record not found');
  }

  return c.json(serializeList(row));
});

// ---------------------------------------------------------------------------
// PUT /api/v1/lists/:id — update
// ---------------------------------------------------------------------------

app.put('/:id', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const listId = c.req.param('id');

  const existing = await c.env.DB.prepare(
    'SELECT * FROM lists WHERE id = ?1 AND account_id = ?2',
  )
    .bind(listId, currentAccount.id)
    .first<ListRow>();

  if (!existing) {
    throw new AppError(404, 'Record not found');
  }

  let body: { title?: string; replies_policy?: string; exclusive?: boolean };
  try {
    body = await c.req.json();
  } catch {
    throw new AppError(422, 'Validation failed', 'Unable to parse request body');
  }

  const now = new Date().toISOString();
  const title = body.title !== undefined ? body.title.trim() : existing.title;
  const repliesPolicy = body.replies_policy ?? existing.replies_policy;
  const exclusive = body.exclusive !== undefined ? (body.exclusive ? 1 : 0) : existing.exclusive;

  await c.env.DB.prepare(
    'UPDATE lists SET title = ?1, replies_policy = ?2, exclusive = ?3, updated_at = ?4 WHERE id = ?5',
  )
    .bind(title, repliesPolicy, exclusive, now, listId)
    .run();

  return c.json({
    id: listId,
    title,
    replies_policy: repliesPolicy,
    exclusive: !!exclusive,
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/lists/:id — delete
// ---------------------------------------------------------------------------

app.delete('/:id', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const listId = c.req.param('id');

  const existing = await c.env.DB.prepare(
    'SELECT id FROM lists WHERE id = ?1 AND account_id = ?2',
  )
    .bind(listId, currentAccount.id)
    .first();

  if (!existing) {
    throw new AppError(404, 'Record not found');
  }

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM list_accounts WHERE list_id = ?1').bind(listId),
    c.env.DB.prepare('DELETE FROM lists WHERE id = ?1').bind(listId),
  ]);

  return c.json({}, 200);
});

// ---------------------------------------------------------------------------
// GET /api/v1/lists/:id/accounts — list members
// ---------------------------------------------------------------------------

app.get('/:id/accounts', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const listId = c.req.param('id');

  const list = await c.env.DB.prepare(
    'SELECT id FROM lists WHERE id = ?1 AND account_id = ?2',
  )
    .bind(listId, currentAccount.id)
    .first();

  if (!list) {
    throw new AppError(404, 'Record not found');
  }

  const { results } = await c.env.DB.prepare(
    `SELECT a.*
     FROM list_accounts la
     JOIN accounts a ON a.id = la.account_id
     WHERE la.list_id = ?1`,
  )
    .bind(listId)
    .all();

  const accounts = (results ?? []).map((row: any) => serializeAccount(row as AccountRow));

  return c.json(accounts);
});

// ---------------------------------------------------------------------------
// POST /api/v1/lists/:id/accounts — add members
// ---------------------------------------------------------------------------

app.post('/:id/accounts', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const listId = c.req.param('id');

  const list = await c.env.DB.prepare(
    'SELECT id FROM lists WHERE id = ?1 AND account_id = ?2',
  )
    .bind(listId, currentAccount.id)
    .first();

  if (!list) {
    throw new AppError(404, 'Record not found');
  }

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

  const stmts: D1PreparedStatement[] = [];
  for (const accountId of accountIds) {
    stmts.push(
      c.env.DB.prepare(
        'INSERT OR IGNORE INTO list_accounts (list_id, account_id, follow_id) VALUES (?1, ?2, NULL)',
      ).bind(listId, accountId),
    );
  }

  await c.env.DB.batch(stmts);

  return c.json({}, 200);
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/lists/:id/accounts — remove members
// ---------------------------------------------------------------------------

app.delete('/:id/accounts', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const listId = c.req.param('id');

  const list = await c.env.DB.prepare(
    'SELECT id FROM lists WHERE id = ?1 AND account_id = ?2',
  )
    .bind(listId, currentAccount.id)
    .first();

  if (!list) {
    throw new AppError(404, 'Record not found');
  }

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

  const stmts: D1PreparedStatement[] = [];
  for (const accountId of accountIds) {
    stmts.push(
      c.env.DB.prepare(
        'DELETE FROM list_accounts WHERE list_id = ?1 AND account_id = ?2',
      ).bind(listId, accountId),
    );
  }

  await c.env.DB.batch(stmts);

  return c.json({}, 200);
});

export default app;
