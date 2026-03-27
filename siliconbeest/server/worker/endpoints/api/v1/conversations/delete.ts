import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

// DELETE /api/v1/conversations/:id — hide conversation
app.delete('/:id', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const conversationId = c.req.param('id');

  const entry = await c.env.DB.prepare(
    'SELECT conversation_id FROM conversation_accounts WHERE conversation_id = ?1 AND account_id = ?2',
  )
    .bind(conversationId, currentAccount.id)
    .first();

  if (!entry) {
    throw new AppError(404, 'Record not found');
  }

  // Remove the user's participation (hides the conversation)
  await c.env.DB.prepare(
    'DELETE FROM conversation_accounts WHERE conversation_id = ?1 AND account_id = ?2',
  )
    .bind(conversationId, currentAccount.id)
    .run();

  return c.json({}, 200);
});

export default app;
