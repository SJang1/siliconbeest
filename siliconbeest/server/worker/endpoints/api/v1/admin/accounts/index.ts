import { Hono } from 'hono';
import type { AppVariables } from '../../../../../types';
import { authRequired, adminRequired } from '../../../../../middleware/auth';

import list from './list';
import fetch from './fetch';
import action from './action';
import approve from './approve';
import reject from './reject';
import role from './role';
import warnings from './warnings';
import undo from './undo';

const app = new Hono<{ Variables: AppVariables }>();

app.use('*', authRequired, adminRequired);

// GET / — list accounts
app.route('/', list);
// POST /:id/action — moderation action
app.route('/', action);
// POST /:id/approve — approve pending
app.route('/', approve);
// POST /:id/reject — reject pending
app.route('/', reject);
// POST /:id/role — change role
app.route('/', role);
// POST /:id/unsuspend, /:id/unsilence, /:id/enable, /:id/unsensitize — undo moderation
app.route('/', undo);
// GET /:id/warnings — warning history
app.route('/', warnings);
// GET /:id — single account (last to avoid catching action/approve/reject/role)
app.route('/', fetch);

export default app;
