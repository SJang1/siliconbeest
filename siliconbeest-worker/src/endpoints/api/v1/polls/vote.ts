import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired } from '../../../../middleware/auth';
import { AppError } from '../../../../middleware/errorHandler';
import { generateUlid } from '../../../../utils/ulid';
import { serializePoll } from '../../../../utils/mastodonSerializer';
import type { PollRow } from '../../../../types/db';

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

  const row = await c.env.DB.prepare('SELECT * FROM polls WHERE id = ?1')
    .bind(pollId)
    .first<PollRow>();

  if (!row) {
    throw new AppError(404, 'Record not found');
  }

  // Check if expired
  if (row.expires_at && new Date(row.expires_at) <= new Date()) {
    throw new AppError(422, 'Validation failed', 'Poll has ended');
  }

  // Parse options to validate choice indices
  let options: Array<string | { title: string; votes_count?: number }>;
  try {
    options = JSON.parse(row.options);
  } catch {
    throw new AppError(500, 'An unexpected error occurred');
  }

  for (const choice of choices) {
    if (choice < 0 || choice >= options.length) {
      throw new AppError(422, 'Validation failed', 'Invalid choice index');
    }
  }

  // Check not multiple if poll doesn't allow it
  if (!row.multiple && choices.length > 1) {
    throw new AppError(422, 'Validation failed', 'Poll does not allow multiple choices');
  }

  // Check not already voted
  const existingVote = await c.env.DB.prepare(
    'SELECT id FROM poll_votes WHERE poll_id = ?1 AND account_id = ?2 LIMIT 1',
  )
    .bind(pollId, currentAccount.id)
    .first();

  if (existingVote) {
    throw new AppError(422, 'Validation failed', 'Already voted on this poll');
  }

  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];

  // Insert vote rows
  for (const choice of choices) {
    const voteId = generateUlid();
    stmts.push(
      c.env.DB.prepare(
        'INSERT INTO poll_votes (id, poll_id, account_id, choice, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
      ).bind(voteId, pollId, currentAccount.id, choice, now),
    );
  }

  // Update poll options votes_count
  const updatedOptions = options.map((o, i) => {
    const opt = typeof o === 'string' ? { title: o, votes_count: 0 } : { ...o, votes_count: o.votes_count ?? 0 };
    if (choices.includes(i)) {
      opt.votes_count += 1;
    }
    return opt;
  });

  stmts.push(
    c.env.DB.prepare(
      'UPDATE polls SET options = ?1, votes_count = votes_count + ?2, voters_count = voters_count + 1 WHERE id = ?3',
    ).bind(JSON.stringify(updatedOptions), choices.length, pollId),
  );

  await c.env.DB.batch(stmts);

  // Fetch updated poll
  const updated = await c.env.DB.prepare('SELECT * FROM polls WHERE id = ?1')
    .bind(pollId)
    .first<PollRow>();

  return c.json(serializePoll(updated!, { voted: true, ownVotes: choices }));
});

export default app;
