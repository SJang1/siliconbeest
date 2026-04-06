import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';

import listApp from './list';
import readApp from './read';
import deleteApp from './delete';

const conversations = new Hono<{ Variables: AppVariables }>();

// GET /api/v1/conversations
conversations.route('/', listApp);

// POST /api/v1/conversations/:id/read
conversations.route('/', readApp);

// DELETE /api/v1/conversations/:id
conversations.route('/', deleteApp);

export default conversations;
