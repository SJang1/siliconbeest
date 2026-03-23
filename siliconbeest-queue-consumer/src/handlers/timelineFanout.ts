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
       AND a.domain IS NULL`,
  )
    .bind(accountId)
    .all<{ account_id: string }>();

  // Build list of local followers + always include the author
  const followerIds = (rows.results ?? []).map((r) => r.account_id);
  if (!followerIds.includes(accountId)) {
    followerIds.push(accountId);
  }

  if (followerIds.length === 0) {
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
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    const batch = statements.slice(i, i + BATCH_SIZE);
    await env.DB.batch(batch);
  }

  console.log(
    `Fanned out status ${statusId} to ${followerIds.length} local timelines`,
  );

  // Send streaming events to all local followers
  // Look up user IDs for all follower account IDs
  if (followerIds.length > 0) {
    const placeholders = followerIds.map(() => '?').join(',');
    const userRows = await env.DB.prepare(
      `SELECT id, account_id FROM users WHERE account_id IN (${placeholders})`,
    )
      .bind(...followerIds)
      .all<{ id: string; account_id: string }>();

    if (userRows.results && userRows.results.length > 0) {
      // Fetch the full status JSON to send as payload
      const statusRow = await env.DB.prepare(
        `SELECT s.id, s.uri, s.content, s.visibility, s.sensitive,
                s.content_warning, s.language, s.url, s.created_at,
                s.in_reply_to_id, s.in_reply_to_account_id,
                s.reblogs_count, s.favourites_count, s.replies_count,
                s.edited_at,
                a.id AS account_id, a.username, a.domain, a.display_name,
                a.note AS account_note, a.url AS account_url, a.uri AS account_uri,
                a.avatar_url, a.header_url, a.locked, a.bot,
                a.followers_count, a.following_count, a.statuses_count,
                a.created_at AS account_created_at
         FROM statuses s
         JOIN accounts a ON a.id = s.account_id
         WHERE s.id = ?`,
      )
        .bind(statusId)
        .first();

      if (statusRow) {
        const statusPayload = JSON.stringify({
          id: statusRow.id,
          uri: statusRow.uri,
          created_at: statusRow.created_at,
          content: statusRow.content,
          visibility: statusRow.visibility,
          sensitive: statusRow.sensitive === 1 || statusRow.sensitive === true,
          spoiler_text: statusRow.content_warning || '',
          language: statusRow.language,
          url: statusRow.url,
          in_reply_to_id: statusRow.in_reply_to_id,
          in_reply_to_account_id: statusRow.in_reply_to_account_id,
          reblogs_count: statusRow.reblogs_count || 0,
          favourites_count: statusRow.favourites_count || 0,
          replies_count: statusRow.replies_count || 0,
          edited_at: statusRow.edited_at,
          media_attachments: [],
          mentions: [],
          tags: [],
          emojis: [],
          reblog: null,
          poll: null,
          card: null,
          application: null,
          text: null,
          filtered: [],
          account: {
            id: statusRow.account_id,
            username: statusRow.username,
            acct: statusRow.domain
              ? `${statusRow.username}@${statusRow.domain}`
              : statusRow.username,
            display_name: statusRow.display_name || '',
            locked: statusRow.locked === 1 || statusRow.locked === true,
            bot: statusRow.bot === 1 || statusRow.bot === true,
            discoverable: true,
            group: false,
            created_at: statusRow.account_created_at,
            note: statusRow.account_note || '',
            url: statusRow.account_url,
            uri: statusRow.account_uri,
            avatar: statusRow.avatar_url || '',
            avatar_static: statusRow.avatar_url || '',
            header: statusRow.header_url || '',
            header_static: statusRow.header_url || '',
            followers_count: statusRow.followers_count || 0,
            following_count: statusRow.following_count || 0,
            statuses_count: statusRow.statuses_count || 0,
            last_status_at: null,
            emojis: [],
            fields: [],
          },
        });

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

        await Promise.allSettled(streamPromises);

        // Also broadcast to public/local streams for public statuses
        if (statusRow.visibility === 'public') {
          const publicStreams = ['public'];
          // If it's a local post, also send to public:local
          if (!statusRow.domain) {
            publicStreams.push('public:local');
          }
          // Use a well-known DO name for public streaming
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
          ).catch(() => {});
        }

        console.log(
          `Sent streaming events for status ${statusId} to ${userRows.results.length} users`,
        );
      }
    }
  }
}
