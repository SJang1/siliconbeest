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
import { serializeAccount } from '../../../../utils/mastodonSerializer';
import { setAccountNote, pinAccount, unpinAccount } from '../../../../services/account';
import type { AccountRow } from '../../../../types/db';

const accounts = new Hono<{ Variables: AppVariables }>();

// GET /api/v1/accounts/:id/lists — lists containing this account
accounts.get('/:id/lists', authRequired, async (c) => {
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
accounts.post('/:id/note', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const targetId = c.req.param('id');
  const body = await c.req.json<{ comment?: string }>();
  const comment = (body.comment ?? '').slice(0, 2000);

  await setAccountNote(currentAccount.id, targetId, comment);

  // Return updated relationship
  const [following, followedBy, blocking, muting] = await Promise.all([
    env.DB.prepare('SELECT id FROM follows WHERE account_id = ?1 AND target_account_id = ?2').bind(currentAccount.id, targetId).first(),
    env.DB.prepare('SELECT id FROM follows WHERE account_id = ?1 AND target_account_id = ?2').bind(targetId, currentAccount.id).first(),
    env.DB.prepare('SELECT id FROM blocks WHERE account_id = ?1 AND target_account_id = ?2').bind(currentAccount.id, targetId).first(),
    env.DB.prepare('SELECT id FROM mutes WHERE account_id = ?1 AND target_account_id = ?2').bind(currentAccount.id, targetId).first(),
  ]);

  return c.json({
    id: targetId,
    following: !!following,
    showing_reblogs: true,
    notifying: false,
    languages: null,
    followed_by: !!followedBy,
    blocking: !!blocking,
    blocked_by: false,
    muting: !!muting,
    muting_notifications: false,
    requested: false,
    requested_by: false,
    domain_blocking: false,
    endorsed: false,
    note: comment,
  });
});

// POST /api/v1/accounts/:id/remove_from_followers — force-remove a follower
accounts.post('/:id/remove_from_followers', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const targetId = c.req.param('id');

  await env.DB.prepare(
    'DELETE FROM follows WHERE account_id = ?1 AND target_account_id = ?2',
  ).bind(targetId, currentAccount.id).run();

  // Decrement counters
  await env.DB.batch([
    env.DB.prepare('UPDATE accounts SET followers_count = MAX(0, followers_count - 1) WHERE id = ?1').bind(currentAccount.id),
    env.DB.prepare('UPDATE accounts SET following_count = MAX(0, following_count - 1) WHERE id = ?1').bind(targetId),
  ]);

  return c.json({
    id: targetId,
    following: false,
    showing_reblogs: true,
    notifying: false,
    languages: null,
    followed_by: false,
    blocking: false,
    blocked_by: false,
    muting: false,
    muting_notifications: false,
    requested: false,
    requested_by: false,
    domain_blocking: false,
    endorsed: false,
    note: '',
  });
});

// POST /api/v1/accounts/:id/pin — endorse/feature account on profile
accounts.post('/:id/pin', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const targetId = c.req.param('id');

  await pinAccount(currentAccount.id, targetId);

  return c.json({
    id: targetId,
    following: true,
    showing_reblogs: true,
    notifying: false,
    languages: null,
    followed_by: false,
    blocking: false,
    blocked_by: false,
    muting: false,
    muting_notifications: false,
    requested: false,
    requested_by: false,
    domain_blocking: false,
    endorsed: true,
    note: '',
  });
});

// POST /api/v1/accounts/:id/unpin — remove endorsement
accounts.post('/:id/unpin', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const targetId = c.req.param('id');

  await unpinAccount(currentAccount.id, targetId);

  return c.json({
    id: targetId,
    following: false,
    showing_reblogs: true,
    notifying: false,
    languages: null,
    followed_by: false,
    blocking: false,
    blocked_by: false,
    muting: false,
    muting_notifications: false,
    requested: false,
    requested_by: false,
    domain_blocking: false,
    endorsed: false,
    note: '',
  });
});

// GET /api/v1/accounts/familiar_followers — mutual followers
accounts.get('/familiar_followers', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const domain = env.INSTANCE_DOMAIN;
  const url = new URL(c.req.url);
  const ids = url.searchParams.getAll('id[]');

  if (ids.length === 0) return c.json([]);

  const result = await Promise.all(
    ids.map(async (targetId) => {
      const { results } = await env.DB.prepare(
        `SELECT a.* FROM follows f1
         JOIN follows f2 ON f2.account_id = f1.account_id AND f2.target_account_id = ?2
         JOIN accounts a ON a.id = f1.account_id
         WHERE f1.target_account_id = ?1
           AND f1.account_id != ?1 AND f1.account_id != ?2
         LIMIT 5`,
      ).bind(currentAccount.id, targetId).all();

      return {
        id: targetId,
        accounts: (results ?? []).map((r: any) =>
          serializeAccount(r as AccountRow, { instanceDomain: domain }),
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
