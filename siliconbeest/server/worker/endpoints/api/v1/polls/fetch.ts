import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { env } from 'cloudflare:workers';
import { authOptional } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';
import { serializePoll } from '../../../../utils/mastodonSerializer';
import type { PollRow } from '../../../../types/db';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

// GET /api/v1/polls/:id
app.get('/:id', authOptional, async (c) => {
  const currentAccount = c.get('currentAccount');
  const pollId = c.req.param('id');

  const row = await env.DB.prepare('SELECT * FROM polls WHERE id = ?1')
    .bind(pollId)
    .first<PollRow>();

  if (!row) {
    throw new AppError(404, 'Record not found');
  }

  let voted = false;
  let ownVotes: number[] = [];

  if (currentAccount) {
    const { results: votes } = await env.DB.prepare(
      'SELECT choice FROM poll_votes WHERE poll_id = ?1 AND account_id = ?2',
    )
      .bind(pollId, currentAccount.id)
      .all();

    if (votes && votes.length > 0) {
      voted = true;
      ownVotes = votes.map((v: any) => v.choice as number);
    }
  }

  return c.json(serializePoll(row, { voted, ownVotes }));
});

export default app;
