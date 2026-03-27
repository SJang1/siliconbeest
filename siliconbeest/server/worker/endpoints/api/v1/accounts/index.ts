import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';

import createApp from './create';
import verifyCredentialsApp from './verifyCredentials';
import updateCredentialsApp from './updateCredentials';
import relationshipsApp from './relationships';
import searchApp from './search';
import lookupApp from './lookup';
import fetchApp from './fetch';
import statusesApp from './statuses';
import followersApp from './followers';
import followingApp from './following';
import followApp from './follow';
import unfollowApp from './unfollow';
import blockApp from './block';
import unblockApp from './unblock';
import muteApp from './mute';
import unmuteApp from './unmute';
import aliasesApp from './aliases';
import migrationApp from './migration';
import { authRequired } from '../../../../middleware/auth';

const accounts = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET /api/v1/accounts/:id/lists — lists containing this account
accounts.get('/:id/lists', authRequired, async (c) => {
  const accountId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;
  const { results } = await c.env.DB.prepare(
    `SELECT l.id, l.title, l.replies_policy FROM lists l
     JOIN list_accounts la ON la.list_id = l.id
     WHERE la.account_id = ?1 AND l.account_id = ?2`,
  ).bind(accountId, currentAccountId).all();
  return c.json((results ?? []).map((r: any) => ({
    id: r.id, title: r.title, replies_policy: r.replies_policy || 'list',
  })));
});

// POST /api/v1/accounts — registration
accounts.route('/', createApp);

// GET /api/v1/accounts/verify_credentials
accounts.route('/', verifyCredentialsApp);

// PATCH /api/v1/accounts/update_credentials
accounts.route('/', updateCredentialsApp);

// GET /api/v1/accounts/relationships
accounts.route('/', relationshipsApp);

// GET /api/v1/accounts/search
accounts.route('/', searchApp);

// GET /api/v1/accounts/lookup
accounts.route('/', lookupApp);

// GET/POST/DELETE /api/v1/accounts/aliases (MUST be before /:id catch-all)
accounts.route('/', aliasesApp);

// POST /api/v1/accounts/migration (MUST be before /:id catch-all)
accounts.route('/', migrationApp);

// GET /api/v1/accounts/:id (catch-all — must be AFTER named routes)
accounts.route('/', fetchApp);

// GET /api/v1/accounts/:id/statuses
accounts.route('/', statusesApp);

// GET /api/v1/accounts/:id/followers
accounts.route('/', followersApp);

// GET /api/v1/accounts/:id/following
accounts.route('/', followingApp);

// POST /api/v1/accounts/:id/follow
accounts.route('/', followApp);

// POST /api/v1/accounts/:id/unfollow
accounts.route('/', unfollowApp);

// POST /api/v1/accounts/:id/block
accounts.route('/', blockApp);

// POST /api/v1/accounts/:id/unblock
accounts.route('/', unblockApp);

// POST /api/v1/accounts/:id/mute
accounts.route('/', muteApp);

// POST /api/v1/accounts/:id/unmute
accounts.route('/', unmuteApp);

export default accounts;
