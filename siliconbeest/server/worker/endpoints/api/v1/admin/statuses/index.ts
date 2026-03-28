import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../../env';
import { authRequired, adminRequired } from '../../../../../middleware/auth';

import deleteStatus from './delete';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.use('*', authRequired, adminRequired);

// DELETE /:id — soft-delete a status
app.route('/', deleteStatus);

export default app;
