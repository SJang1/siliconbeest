import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

// POST /api/v1/conversations/:id/read — mark as read
app.post('/:id/read', authRequired, async (c) => {
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

  await c.env.DB.prepare(
    'UPDATE conversation_accounts SET unread = 0 WHERE conversation_id = ?1 AND account_id = ?2',
  )
    .bind(conversationId, currentAccount.id)
    .run();

  return c.json({
    id: conversationId,
    accounts: [],
    last_status: null,
    unread: false,
  });
});

export default app;
