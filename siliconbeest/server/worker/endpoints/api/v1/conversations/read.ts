import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { markConversationRead } from '../../../../services/conversation';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

// POST /api/v1/conversations/:id/read — mark as read
app.post('/:id/read', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const conversationId = c.req.param('id');

  await markConversationRead(c.env.DB, conversationId, currentAccount.id);

  return c.json({
    id: conversationId,
    accounts: [],
    last_status: null,
    unread: false,
  });
});

export default app;
