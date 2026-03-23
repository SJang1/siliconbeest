import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../env';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.get('/', (c) => {
  // No custom emojis configured yet
  return c.json([]);
});

export default app;
