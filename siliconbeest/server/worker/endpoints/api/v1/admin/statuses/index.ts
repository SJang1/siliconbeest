import { Hono } from 'hono';
import type { AppVariables } from '../../../../../types';
import { authRequired, adminRequired } from '../../../../../middleware/auth';

import deleteStatus from './delete';

const app = new Hono<{ Variables: AppVariables }>();

app.use('*', authRequired, adminRequired);

// DELETE /:id — soft-delete a status
app.route('/', deleteStatus);

export default app;
