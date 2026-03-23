import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';

import createApp from './create';
import fetchApp from './fetch';
import deleteApp from './delete';
import contextApp from './context';
import favouriteApp from './favourite';
import unfavouriteApp from './unfavourite';
import reblogApp from './reblog';
import unreblogApp from './unreblog';
import bookmarkApp from './bookmark';
import unbookmarkApp from './unbookmark';
import favouritedByApp from './favouritedBy';
import rebloggedByApp from './rebloggedBy';

const statuses = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// POST /api/v1/statuses — create status
statuses.route('/', createApp);

// GET /api/v1/statuses/:id
statuses.route('/', fetchApp);

// DELETE /api/v1/statuses/:id
statuses.route('/', deleteApp);

// GET /api/v1/statuses/:id/context
statuses.route('/', contextApp);

// POST /api/v1/statuses/:id/favourite
statuses.route('/', favouriteApp);

// POST /api/v1/statuses/:id/unfavourite
statuses.route('/', unfavouriteApp);

// POST /api/v1/statuses/:id/reblog
statuses.route('/', reblogApp);

// POST /api/v1/statuses/:id/unreblog
statuses.route('/', unreblogApp);

// POST /api/v1/statuses/:id/bookmark
statuses.route('/', bookmarkApp);

// POST /api/v1/statuses/:id/unbookmark
statuses.route('/', unbookmarkApp);

// GET /api/v1/statuses/:id/favourited_by
statuses.route('/', favouritedByApp);

// GET /api/v1/statuses/:id/reblogged_by
statuses.route('/', rebloggedByApp);

export default statuses;
