import { Hono } from 'hono';
import type { AppVariables } from '../../../../../types';
import { authRequired, adminRequired } from '../../../../../middleware/auth';

import list from './list';
import fetch from './fetch';
import resolve from './resolve';
import assign from './assign';

const app = new Hono<{ Variables: AppVariables }>();

app.use('*', authRequired, adminRequired);

// GET / — list reports
app.route('/', list);
// POST /:id/resolve — resolve report
app.route('/', resolve);
// POST /:id/assign_to_self + POST /:id/unassign
app.route('/', assign);
// GET /:id — single report (last to avoid catching other routes)
app.route('/', fetch);

export default app;
