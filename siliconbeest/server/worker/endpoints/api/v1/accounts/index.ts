import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../../types';

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
import { requireScope } from '../../../../middleware/scopeCheck';
import { serializeAccount } from '../../../../utils/mastodonSerializer';
import {
  getRelationship,
  pinAccount,
  removeFollower,
  setAccountNote,
  unpinAccount,
} from '../../../../services/account';
import type { AccountRow } from '../../../../types/db';
import { buildAccountDiscoverySqlPredicate } from '../../../../services/permissions';

const accounts = new Hono<{ Variables: AppVariables }>();

// GET /api/v1/accounts/:id/lists — lists containing this account
accounts.get('/:id/lists', authRequired, requireScope('read:lists'), async (c) => {
  const accountId = c.req.param('id');
  const currentAccountId = c.get('currentUser')!.account_id;
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.title, l.replies_policy FROM lists l
     JOIN list_accounts la ON la.list_id = l.id
     WHERE la.account_id = ?1 AND l.account_id = ?2`,
  ).bind(accountId, currentAccountId).all();
  return c.json((results ?? []).map((r: any) => ({
    id: r.id, title: r.title, replies_policy: r.replies_policy || 'list',
  })));
});

// POST /api/v1/accounts/:id/note — set personal note on account
accounts.post('/:id/note', authRequired, requireScope('write:accounts'), async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const targetId = c.req.param('id');
  const body = await c.req.json<{ comment?: string }>();
  const comment = (body.comment ?? '').slice(0, 2000);

  const changed = await setAccountNote(currentAccount.id, targetId, comment);
  c.set('contributionApplied', changed);

  return c.json(await getRelationship(currentAccount.id, targetId));
});

// POST /api/v1/accounts/:id/remove_from_followers — force-remove a follower
accounts.post('/:id/remove_from_followers', authRequired, requireScope('write:follows'), async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const targetId = c.req.param('id');

  const changed = await removeFollower(currentAccount.id, targetId);
  c.set('contributionApplied', changed);
  return c.json(await getRelationship(currentAccount.id, targetId));
});

// POST /api/v1/accounts/:id/pin — endorse/feature account on profile
accounts.post('/:id/pin', authRequired, requireScope('write:accounts'), async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const targetId = c.req.param('id');

  const changed = await pinAccount(currentAccount.id, targetId);
  c.set('contributionApplied', changed);

  return c.json(await getRelationship(currentAccount.id, targetId));
});

// POST /api/v1/accounts/:id/unpin — remove endorsement
accounts.post('/:id/unpin', authRequired, requireScope('write:accounts'), async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const targetId = c.req.param('id');

  const changed = await unpinAccount(currentAccount.id, targetId);
  c.set('contributionApplied', changed);

  return c.json(await getRelationship(currentAccount.id, targetId));
});

// GET /api/v1/accounts/familiar_followers — mutual followers
accounts.get('/familiar_followers', authRequired, requireScope('read:follows'), async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const domain = env.INSTANCE_DOMAIN;
  const url = new URL(c.req.url);
  const ids = url.searchParams.getAll('id[]');

  if (ids.length === 0) return c.json([]);

  const result = await Promise.all(
    ids.map(async (targetId) => {
      const accountPermission = buildAccountDiscoverySqlPredicate(
        'account',
        currentAccount.id,
        new Date().toISOString(),
      );
      const targetVisible = await env.DB.prepare(
        `SELECT a.id FROM accounts a
         WHERE a.id = ?
           AND ${accountPermission.sql}
         LIMIT 1`,
      ).bind(targetId, ...accountPermission.bindings).first<{ id: string }>();
      if (!targetVisible) return { id: targetId, accounts: [] };

      const { results } = await env.DB.prepare(
        `SELECT a.* FROM follows viewer_follow
         JOIN follows target_follow
           ON target_follow.account_id = viewer_follow.target_account_id
          AND target_follow.target_account_id = ?
         JOIN accounts a ON a.id = viewer_follow.target_account_id
         WHERE viewer_follow.account_id = ?
           AND a.id != ? AND a.id != ?
           AND ${accountPermission.sql}
         LIMIT 5`,
      ).bind(
        targetId,
        currentAccount.id,
        currentAccount.id,
        targetId,
        ...accountPermission.bindings,
      ).all<AccountRow>();

      return {
        id: targetId,
        accounts: (results ?? []).map((row) =>
          serializeAccount(row, { instanceDomain: domain }),
        ),
      };
    }),
  );

  return c.json(result);
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
