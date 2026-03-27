import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';

import tags from './tags';
import statuses from './statuses';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.route('/tags', tags);
app.route('/statuses', statuses);

export default app;
