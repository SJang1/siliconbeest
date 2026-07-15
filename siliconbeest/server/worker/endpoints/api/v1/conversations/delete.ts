import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { deleteConversation } from '../../../../services/conversation';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

// DELETE /api/v1/conversations/:id — hide conversation
app.delete('/:id', authRequired, requireScope('write:conversations'), async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const conversationId = c.req.param('id');

  const changed = await deleteConversation(conversationId, currentAccount.id);
  c.set('contributionApplied', changed);

  return c.json({}, 200);
});

export default app;
