/**
 * CSV Export Endpoints
 *
 * Mastodon-compatible CSV export for account migration.
 * All routes require authentication and return text/csv with UTF-8 BOM.
 */

import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../types';
import { authRequired } from '../../../middleware/auth';
import {
	getFollowingForExport,
	getFollowersForExport,
	getBlocksForExport,
	getMutesForExport,
	getBookmarksForExport,
	getListsForExport,
} from '../../../services/account';

type HonoEnv = { Variables: AppVariables };

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
  const results = await getFollowingForExport(account.id);
  const rows = results.map((r) => `${formatAcct(r.username, r.domain)},true`);
  return csvResponse(`Account address,Show boosts\n${rows.join('\n')}\n`);
});

// ---------------------------------------------------------------------------
// GET /followers.csv
// ---------------------------------------------------------------------------

app.get('/followers.csv', authRequired, async (c) => {
  const account = c.get('currentAccount')!;
  const results = await getFollowersForExport(account.id);
  const rows = results.map((r) => formatAcct(r.username, r.domain));
  return csvResponse(`Account address\n${rows.join('\n')}\n`);
});

// ---------------------------------------------------------------------------
// GET /blocks.csv
// ---------------------------------------------------------------------------

app.get('/blocks.csv', authRequired, async (c) => {
  const account = c.get('currentAccount')!;
  const results = await getBlocksForExport(account.id);
  const rows = results.map((r) => formatAcct(r.username, r.domain));
  return csvResponse(`Account address\n${rows.join('\n')}\n`);
});

// ---------------------------------------------------------------------------
// GET /mutes.csv
// ---------------------------------------------------------------------------

app.get('/mutes.csv', authRequired, async (c) => {
  const account = c.get('currentAccount')!;
  const results = await getMutesForExport(account.id);
  const rows = results.map((r) => formatAcct(r.username, r.domain));
  return csvResponse(`Account address\n${rows.join('\n')}\n`);
});

// ---------------------------------------------------------------------------
// GET /bookmarks.csv
// ---------------------------------------------------------------------------

app.get('/bookmarks.csv', authRequired, async (c) => {
  const account = c.get('currentAccount')!;
  const results = await getBookmarksForExport(account.id);
  return csvResponse(`${results.join('\n')}\n`);
});

// ---------------------------------------------------------------------------
// GET /lists.csv
// ---------------------------------------------------------------------------

app.get('/lists.csv', authRequired, async (c) => {
  const account = c.get('currentAccount')!;
  const results = await getListsForExport(account.id);
  const rows = results.map((r) => `${r.title},${formatAcct(r.username, r.domain)}`);
  return csvResponse(`List name,Account address\n${rows.join('\n')}\n`);
});

export default app;
