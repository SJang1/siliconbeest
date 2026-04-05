import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../env';
import { getRules } from '../../../services/instance';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

// GET /api/v1/instance/rules — list instance rules (no auth required)
app.get('/', async (c) => {
  const ruleRows = await getRules(c.env.DB);

  const rules = ruleRows.map((row) => ({
    id: row.id,
    text: row.text,
    hint: '',
  }));

  return c.json(rules);
});

export default app;
