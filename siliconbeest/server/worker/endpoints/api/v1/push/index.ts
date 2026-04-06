/**
 * Combined router for Web Push subscription endpoints.
 *
 * All routes are mounted at /api/v1/push/subscription
 */

import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';

import subscribe from './subscribe';
import get from './get';
import update from './update';
import unsubscribe from './unsubscribe';

const app = new Hono<{ Variables: AppVariables }>();

// POST   /  — create subscription
app.route('/', subscribe);

// GET    /  — get current subscription
app.route('/', get);

// PUT    /  — update alerts / policy
app.route('/', update);

// DELETE /  — remove subscription
app.route('/', unsubscribe);

export default app;
