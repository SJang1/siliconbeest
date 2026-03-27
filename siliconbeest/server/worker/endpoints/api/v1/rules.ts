import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../env';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

// GET /api/v1/instance/rules — list instance rules (no auth required)
app.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM rules ORDER BY priority ASC, created_at ASC',
  ).all();

  const rules = (results ?? []).map((row: any) => ({
    id: row.id as string,
    text: row.text as string,
    hint: '',
  }));

  return c.json(rules);
});

export default app;
