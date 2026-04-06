import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import home from './home';
import publicTimeline from './public';
import tag from './tag';
import list from './list';

const app = new Hono<{ Variables: AppVariables }>();

app.route('/home', home);
app.route('/public', publicTimeline);
app.route('/tag', tag);
app.route('/list', list);

export default app;
