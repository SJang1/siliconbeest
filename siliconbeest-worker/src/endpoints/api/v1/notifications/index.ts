import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import list from './list';
import fetch from './fetch';
import clear from './clear';
import dismiss from './dismiss';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// GET / — list notifications
app.route('/', list);
// POST /clear — clear all
app.route('/', clear);
// POST /:id/dismiss — dismiss single
app.route('/', dismiss);
// GET /:id — single notification (must be last to avoid catching /clear)
app.route('/', fetch);

export default app;
