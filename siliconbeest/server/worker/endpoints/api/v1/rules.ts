import { Hono } from 'hono';
import type { AppVariables } from '../../../types';
import { getRules } from '../../../services/instance';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

// GET /api/v1/instance/rules — list instance rules (no auth required)
app.get('/', async (c) => {
  const ruleRows = await getRules();

  const rules = ruleRows.map((row) => ({
    id: row.id,
    text: row.text,
    hint: '',
  }));

  return c.json(rules);
});

export default app;
