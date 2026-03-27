/**
 * CSV Export Endpoints
 *
 * Mastodon-compatible CSV export for account migration.
 * All routes require authentication and return text/csv with UTF-8 BOM.
 */

import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../env';
import { authRequired } from '../../../middleware/auth';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** UTF-8 BOM for Excel compatibility. */
const BOM = '\uFEFF';

/** Format account address: @username@domain for remote, @username for local. */
function formatAcct(username: string, domain: string | null): string {
  return domain ? `@${username}@${domain}` : `@${username}`;
}

/** Build a CSV Response with UTF-8 BOM. */
function csvResponse(body: string): Response {
  return new Response(BOM + body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment',
    },
  });
}

// ---------------------------------------------------------------------------
// GET /following.csv
// ---------------------------------------------------------------------------

app.get('/following.csv', authRequired, async (c) => {
  const account = c.get('currentAccount')!;

  const { results } = await c.env.DB.prepare(
    `SELECT a.username, a.domain
     FROM follows f
     JOIN accounts a ON a.id = f.target_account_id
     WHERE f.account_id = ?`,
  )
    .bind(account.id)
    .all();

  const rows = (results ?? []).map(
    (r: any) => `${formatAcct(r.username, r.domain)},true`,
  );

  return csvResponse(`Account address,Show boosts\n${rows.join('\n')}\n`);
});

// ---------------------------------------------------------------------------
// GET /followers.csv
// ---------------------------------------------------------------------------

app.get('/followers.csv', authRequired, async (c) => {
  const account = c.get('currentAccount')!;

  const { results } = await c.env.DB.prepare(
    `SELECT a.username, a.domain
     FROM follows f
     JOIN accounts a ON a.id = f.account_id
     WHERE f.target_account_id = ?`,
  )
    .bind(account.id)
    .all();

  const rows = (results ?? []).map((r: any) => formatAcct(r.username, r.domain));

  return csvResponse(`Account address\n${rows.join('\n')}\n`);
});

// ---------------------------------------------------------------------------
// GET /blocks.csv
// ---------------------------------------------------------------------------

app.get('/blocks.csv', authRequired, async (c) => {
  const account = c.get('currentAccount')!;

  const { results } = await c.env.DB.prepare(
    `SELECT a.username, a.domain
     FROM blocks bl
     JOIN accounts a ON a.id = bl.target_account_id
     WHERE bl.account_id = ?`,
  )
    .bind(account.id)
    .all();

  const rows = (results ?? []).map((r: any) => formatAcct(r.username, r.domain));

  return csvResponse(`Account address\n${rows.join('\n')}\n`);
});

// ---------------------------------------------------------------------------
// GET /mutes.csv
// ---------------------------------------------------------------------------

app.get('/mutes.csv', authRequired, async (c) => {
  const account = c.get('currentAccount')!;

  const { results } = await c.env.DB.prepare(
    `SELECT a.username, a.domain
     FROM mutes m
     JOIN accounts a ON a.id = m.target_account_id
     WHERE m.account_id = ?`,
  )
    .bind(account.id)
    .all();

  const rows = (results ?? []).map((r: any) => formatAcct(r.username, r.domain));

  return csvResponse(`Account address\n${rows.join('\n')}\n`);
});

// ---------------------------------------------------------------------------
// GET /bookmarks.csv
// ---------------------------------------------------------------------------

app.get('/bookmarks.csv', authRequired, async (c) => {
  const account = c.get('currentAccount')!;

  const { results } = await c.env.DB.prepare(
    `SELECT s.uri
     FROM bookmarks b
     JOIN statuses s ON s.id = b.status_id
     WHERE b.account_id = ?`,
  )
    .bind(account.id)
    .all();

  const rows = (results ?? []).map((r: any) => r.uri as string);

  return csvResponse(`${rows.join('\n')}\n`);
});

// ---------------------------------------------------------------------------
// GET /lists.csv
// ---------------------------------------------------------------------------

app.get('/lists.csv', authRequired, async (c) => {
  const account = c.get('currentAccount')!;

  const { results } = await c.env.DB.prepare(
    `SELECT l.title, a.username, a.domain
     FROM lists l
     JOIN list_accounts la ON la.list_id = l.id
     JOIN accounts a ON a.id = la.account_id
     WHERE l.account_id = ?
     ORDER BY l.title ASC`,
  )
    .bind(account.id)
    .all();

  const rows = (results ?? []).map(
    (r: any) => `${r.title},${formatAcct(r.username, r.domain)}`,
  );

  return csvResponse(`List name,Account address\n${rows.join('\n')}\n`);
});

export default app;
