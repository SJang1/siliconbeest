/**
 * Timeline Fanout Handler
 *
 * Loads all local followers of the account and batch-inserts
 * the status into their home_timeline_entries using D1 batch.
 */

import { env } from 'cloudflare:workers';
import type { TimelineFanoutMessage } from '../shared/types/queue';
import { measureAsync, PerfTimer } from '../observability/performance';
import { buildStatusStreamingPayload } from '../../../packages/shared/utils/streamingPayload';

export async function handleTimelineFanout(
  msg: TimelineFanoutMessage,
): Promise<void> {
  const { statusId, accountId } = msg;
  const timer = new PerfTimer('timelineFanout.total', { statusId });
  timer.start();

  // Skip DM fanout — DMs should not appear in followers' timelines
  const statusCheck = await measureAsync(
    'timelineFanout.db.checkVisibility',
    () => env.DB.prepare('SELECT visibility FROM statuses WHERE id = ? LIMIT 1')
      .bind(statusId)
      .first<{ visibility: string }>(),
    { statusId }
  );

  if (statusCheck?.visibility === 'direct') {
    console.log(`Skipping timeline fanout for DM status ${statusId}`);
    timer.stopWithMetadata({ status: 'skipped_dm' });
    return;
  }

  // Load all local followers of this account
  // Local accounts have domain IS NULL
  const rows = await measureAsync(
    'timelineFanout.db.loadFollowers',
    () => env.DB.prepare(
      `SELECT f.account_id
       FROM follows f
       JOIN accounts a ON a.id = f.account_id
       WHERE f.target_account_id = ?
         AND a.domain IS NULL`,
    )
      .bind(accountId)
      .all<{ account_id: string }>(),
    { accountId }
  );

  // Build list of local followers + always include the author
  const allFollowerIds = (rows.results ?? []).map((r) => r.account_id);
  if (!allFollowerIds.includes(accountId)) {
    allFollowerIds.push(accountId);
  }

  // Filter out followers who have blocked or muted the author
  let followerIds = allFollowerIds;
  if (allFollowerIds.length > 0) {
    const now = new Date().toISOString();
    const placeholders = allFollowerIds.map(() => '?').join(',');
    const blockedBy = await env.DB.prepare(
      `SELECT account_id FROM blocks WHERE target_account_id = ? AND account_id IN (${placeholders})`,
    ).bind(accountId, ...allFollowerIds).all<{ account_id: string }>();
    const mutedBy = await env.DB.prepare(
      `SELECT account_id FROM mutes WHERE target_account_id = ? AND account_id IN (${placeholders}) AND (expires_at IS NULL OR expires_at > ?)`,
    ).bind(accountId, ...allFollowerIds, now).all<{ account_id: string }>();

    const excludeSet = new Set([
      ...(blockedBy.results ?? []).map((r) => r.account_id),
      ...(mutedBy.results ?? []).map((r) => r.account_id),
    ]);

    if (excludeSet.size > 0) {
      followerIds = allFollowerIds.filter((id) => !excludeSet.has(id));
      console.log(`Filtered ${excludeSet.size} blocked/muted followers from fanout for status ${statusId}`);
    }
  }

  if (followerIds.length === 0) {
    timer.stopWithMetadata({ status: 'no_followers', followerCount: 0 });
    return;
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
  await measureAsync(
    'timelineFanout.db.batchInsert',
    async () => {
      for (let i = 0; i < statements.length; i += BATCH_SIZE) {
        const batch = statements.slice(i, i + BATCH_SIZE);
        await env.DB.batch(batch);
      }
    },
    { followerCount: followerIds.length, batchCount: Math.ceil(statements.length / BATCH_SIZE) }
  );

  console.log(
    `Fanned out status ${statusId} to ${followerIds.length} local timelines`,
  );

  // Build the streaming payload once — reused for both follower and public streams
  const statusPayload = await measureAsync(
    'timelineFanout.buildStreamingPayload',
    () => buildStatusStreamingPayload(env.DB, statusId, env.INSTANCE_DOMAIN),
    { statusId }
  );

  // Send streaming events to all local followers
  if (statusPayload && followerIds.length > 0) {
    const placeholders = followerIds.map(() => '?').join(',');
    const userRows = await measureAsync(
      'timelineFanout.db.loadUsers',
      () => env.DB.prepare(
        `SELECT id, account_id FROM users WHERE account_id IN (${placeholders})`,
      )
        .bind(...followerIds)
        .all<{ id: string; account_id: string }>(),
      { followerCount: followerIds.length }
    );

    if (userRows.results && userRows.results.length > 0) {
      // Send streaming event to each user via worker service binding
      const streamPromises = userRows.results.map((user) =>
        env.WORKER.fetch(
          new Request('http://internal/internal/stream-event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: user.id,
              event: 'update',
              payload: statusPayload,
              stream: ['user'],
            }),
          }),
        ).catch((err) => {
          console.error(`Failed to send stream event to user ${user.id}:`, err);
        }),
      );

      await measureAsync(
        'timelineFanout.streaming.sendEvents',
        () => Promise.allSettled(streamPromises),
        { userCount: userRows.results.length }
      );

      console.log(
        `Sent streaming events for status ${statusId} to ${userRows.results.length} users`,
      );
    }
  }

  timer.stopWithMetadata({
    status: 'success',
    followerCount: followerIds.length
  });

  // Broadcast to public/local streams — INDEPENDENT of follower count
  if (statusPayload && statusCheck?.visibility === 'public') {
    // Determine if the status is from a local account
    const authorAccount = await env.DB.prepare(
      'SELECT domain FROM accounts WHERE id = ? LIMIT 1',
    ).bind(accountId).first<{ domain: string | null }>();

    const publicStreams = ['public'];
    if (!authorAccount?.domain) publicStreams.push('public:local');

    console.log(`Broadcasting to public streams: ${publicStreams.join(', ')} for status ${statusId}`);
    await env.WORKER.fetch(
      new Request('http://internal/internal/stream-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: '__public__',
          event: 'update',
          payload: statusPayload,
          stream: publicStreams,
        }),
      }),
    ).catch((err) => {
      console.error(`Failed to broadcast to public streams:`, err);
    });
  }
}
