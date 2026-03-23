/**
 * Timeline Fanout Handler
 *
 * Loads all local followers of the account and batch-inserts
 * the status into their home_timeline_entries using D1 batch.
 */

import type { Env } from '../env';
import type { TimelineFanoutMessage } from '../shared/types/queue';

export async function handleTimelineFanout(
  msg: TimelineFanoutMessage,
  env: Env,
): Promise<void> {
  const { statusId, accountId } = msg;

  // Load all local followers of this account
  // Local accounts have domain IS NULL
  const rows = await env.DB.prepare(
    `SELECT f.account_id
     FROM follows f
     JOIN accounts a ON a.id = f.account_id
     WHERE f.target_account_id = ?
       AND a.domain IS NULL
       AND f.accepted = 1`,
  )
    .bind(accountId)
    .all<{ account_id: string }>();

  if (!rows.results || rows.results.length === 0) {
    console.log(`No local followers for account ${accountId}, skipping timeline fanout`);
    return;
  }

  // Also include the author's own timeline
  const followerIds = rows.results.map((r) => r.account_id);
  if (!followerIds.includes(accountId)) {
    followerIds.push(accountId);
  }

  // Batch insert into home_timeline_entries using D1 batch
  // D1 batch can handle many statements efficiently
  const BATCH_SIZE = 50;
  const statements: D1PreparedStatement[] = [];

  for (const followerId of followerIds) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO home_timeline_entries (account_id, status_id, created_at)
         VALUES (?, ?, datetime('now'))`,
      ).bind(followerId, statusId),
    );
  }

  // Execute in batches (D1 batch has limits)
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    const batch = statements.slice(i, i + BATCH_SIZE);
    await env.DB.batch(batch);
  }

  console.log(
    `Fanned out status ${statusId} to ${followerIds.length} local timelines`,
  );
}
