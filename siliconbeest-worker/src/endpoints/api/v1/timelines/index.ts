import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import home from './home';
import publicTimeline from './public';
import tag from './tag';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.route('/home', home);
app.route('/public', publicTimeline);
app.route('/tag', tag);

export default app;
