import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';

import fetchApp from './fetch';
import voteApp from './vote';

const polls = new Hono<{ Variables: AppVariables }>();

// GET /api/v1/polls/:id
polls.route('/', fetchApp);

// POST /api/v1/polls/:id/votes
polls.route('/', voteApp);

export default polls;
