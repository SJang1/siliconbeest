import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';

import createApp from './create';
import verifyCredentialsApp from './verifyCredentials';
import updateCredentialsApp from './updateCredentials';
import relationshipsApp from './relationships';
import searchApp from './search';
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

const accounts = new Hono<{ Bindings: Env; Variables: AppVariables }>();

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

// GET /api/v1/accounts/:id
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
