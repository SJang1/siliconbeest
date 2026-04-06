import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';

import tags from './tags';
import statuses from './statuses';
import links from './links';

const app = new Hono<{ Variables: AppVariables }>();

app.route('/tags', tags);
app.route('/statuses', statuses);
app.route('/links', links);

export default app;
