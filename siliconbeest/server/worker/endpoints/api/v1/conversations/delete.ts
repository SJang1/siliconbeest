import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { authRequired } from '../../../../middleware/auth';
import { deleteConversation } from '../../../../services/conversation';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

// DELETE /api/v1/conversations/:id — hide conversation
app.delete('/:id', authRequired, async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const conversationId = c.req.param('id');

  await deleteConversation(conversationId, currentAccount.id);

  return c.json({}, 200);
});

export default app;
