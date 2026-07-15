import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { authRequired } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { markConversationRead } from '../../../../services/conversation';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

// POST /api/v1/conversations/:id/read — mark as read
app.post('/:id/read', authRequired, requireScope('write:conversations'), async (c) => {
  const currentAccount = c.get('currentAccount')!;
  const conversationId = c.req.param('id');

  const changed = await markConversationRead(conversationId, currentAccount.id);
  c.set('contributionApplied', changed);

  return c.json({
    id: conversationId,
    accounts: [],
    last_status: null,
    unread: false,
  });
});

export default app;
