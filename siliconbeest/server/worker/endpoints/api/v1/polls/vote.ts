import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';
import { votePoll } from '../../../../services/status';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

// POST /api/v1/polls/:id/votes
app.post('/:id/votes', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const pollId = c.req.param('id');

  let body: { choices?: number[] };
  try {
    body = await c.req.json();
  } catch {
    throw new AppError(422, 'Validation failed', 'Unable to parse request body');
  }

  const choices = body.choices;
  if (!choices || !Array.isArray(choices) || choices.length === 0) {
    throw new AppError(422, 'Validation failed', 'choices is required');
  }

  const { poll } = await votePoll(c.env.DB, currentAccount.id, pollId, choices);

  return c.json(poll);
});

export default app;
