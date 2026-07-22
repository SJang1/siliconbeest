import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { env } from 'cloudflare:workers';
import { authOptional } from '../../../../middleware/auth';
import { requireScope } from '../../../../middleware/scopeCheck';
import { AppError } from '../../../../middleware/errorHandler';
import { serializePoll } from '../../../../utils/mastodonSerializer';
import type { PollRow } from '../../../../types/db';
import { assertStatusViewable } from '../../../../services/permissions';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

// GET /api/v1/polls/:id
app.get('/:id', authOptional, requireScope('read:statuses'), async (c) => {
  const currentAccount = c.get('currentAccount');
  const pollId = c.req.param('id');

  const row = await env.DB_META_C000.prepare('SELECT * FROM polls WHERE id = ?1')
    .bind(pollId)
    .first<PollRow>();

  if (!row) {
    throw new AppError(404, 'Record not found');
  }
  await assertStatusViewable(row.status_id, currentAccount?.id ?? null);

  let voted = false;
  let ownVotes: number[] = [];

  if (currentAccount) {
    const { results: votes } = await env.DB_META_C000.prepare(
      'SELECT choice FROM poll_votes WHERE poll_id = ?1 AND account_id = ?2',
    )
      .bind(pollId, currentAccount.id)
      .all<{ choice: number }>();

    if (votes && votes.length > 0) {
      voted = true;
      ownVotes = votes.map((vote) => vote.choice);
    }
  }

  return c.json(serializePoll(row, { voted, ownVotes }));
});

export default app;
