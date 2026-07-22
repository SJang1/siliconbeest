/**
 * Timeline Fanout Handler
 *
 * Loads eligible local followers and emits real-time streaming events. Home
 * timeline persistence is derived on read from statuses and follows.
 */

import { env } from 'cloudflare:workers';
import type { TimelineFanoutMessage } from '../shared/types/queue';
import { measureAsync, PerfTimer } from '../observability/performance';
import { buildStatusStreamingPayload } from '../../../packages/shared/utils/streamingPayload';
import {
  canBroadcastStatusToPublicStreams,
  canFanOutStatus,
} from '../../../packages/shared/permissions';
import { sendStreamEvent } from '../../../siliconbeest/server/worker/services/streaming';
import { projectRealtimeFeed } from '../../../siliconbeest/server/worker/services/realtimeFeed';

export async function handleTimelineFanout(
  msg: TimelineFanoutMessage,
): Promise<void> {
  const { statusId, accountId, cursor } = msg;
  const timer = new PerfTimer('timelineFanout.total', { statusId });
  timer.start();

  const statusCheck = await measureAsync(
    'timelineFanout.db.checkPermissions',
    () => env.DB_META_C000.prepare(
      `SELECT s.account_id, s.visibility, s.deleted_at, s.reblog_of_id,
              s.quote_id, a.suspended_at, a.silenced_at,
              a.domain AS author_domain,
              COALESCE(s.sort_at_ms, CAST(unixepoch(s.created_at) AS INTEGER) * 1000) AS sort_at_ms,
              COALESCE(s.source_version, 1) AS source_version
       FROM statuses s
       JOIN accounts a ON a.id = s.account_id
       WHERE s.id = ?
       LIMIT 1`,
    )
      .bind(statusId)
      .first<{
        account_id: string;
        visibility: string | null;
        deleted_at: string | null;
        reblog_of_id: string | null;
        quote_id: string | null;
        suspended_at: string | null;
        silenced_at: string | null;
        author_domain: string | null;
        sort_at_ms: number;
        source_version: number;
      }>(),
    { statusId }
  );

  const canFanOut = canFanOutStatus({
    statusAccountId: statusCheck?.account_id ?? null,
    messageAccountId: accountId,
    visibility: statusCheck?.visibility ?? null,
    statusDeleted: statusCheck ? statusCheck.deleted_at !== null : null,
    authorSuspended: statusCheck ? statusCheck.suspended_at !== null : null,
  });

  if (!statusCheck || !canFanOut) {
    console.warn(
      `Dropping unauthorized timeline fanout for status ${statusId} and account ${accountId}`,
    );
    timer.stopWithMetadata({ status: 'permission_denied' });
    return;
  }

  const canBroadcastPublicly = canBroadcastStatusToPublicStreams({
    visibility: statusCheck.visibility,
    statusDeleted: statusCheck.deleted_at !== null,
    authorSuspended: statusCheck.suspended_at !== null,
    authorSilenced: statusCheck.silenced_at !== null,
  });
  const hasAudienceSensitiveNestedStatus = statusCheck.reblog_of_id !== null
    || statusCheck.quote_id !== null;

  // Resolve operational local recipients. The UNION includes the author only
  // when the author also has an active local user.
  const rows = await measureAsync(
    'timelineFanout.db.loadFollowers',
    () => env.DB_META_C000.prepare(
      `SELECT candidate.account_id
       FROM (
         SELECT f.account_id
         FROM follows f
         WHERE f.target_account_id = ?1
         UNION
         SELECT ?1 WHERE ?2 IS NULL
       ) candidate
       JOIN accounts recipient ON recipient.id = candidate.account_id
       JOIN users recipient_user ON recipient_user.account_id = recipient.id
       WHERE recipient.domain IS NULL
         AND recipient.suspended_at IS NULL
         AND recipient.memorial = 0
         AND recipient_user.disabled = 0
         AND recipient_user.approved = 1
         AND (?2 IS NULL OR candidate.account_id > ?2)
       ORDER BY candidate.account_id
       LIMIT 81`,
    )
      .bind(accountId, cursor ?? null)
      .all<{ account_id: string }>(),
    { accountId }
  );

  const candidateIds = (rows.results ?? []).map((r) => r.account_id);
  const hasContinuation = candidateIds.length > 80;
  const allFollowerIds = candidateIds.slice(0, 80);

  // Filter either block direction and active viewer-to-author mutes. Follow
  // rows can remain stale after a relationship restriction is created.
  let followerIds = allFollowerIds;
  const relationshipCheckAt = new Date().toISOString();
  if (allFollowerIds.length > 0) {
    const placeholders = allFollowerIds.map(() => '?').join(',');
    const blockedBy = await env.DB_META_C000.prepare(
      `SELECT account_id FROM blocks WHERE target_account_id = ? AND account_id IN (${placeholders})`,
    ).bind(accountId, ...allFollowerIds).all<{ account_id: string }>();
    const mutedBy = await env.DB_META_C000.prepare(
      `SELECT account_id FROM mutes WHERE target_account_id = ? AND account_id IN (${placeholders}) AND (expires_at IS NULL OR expires_at > ?)`,
    ).bind(accountId, ...allFollowerIds, relationshipCheckAt).all<{ account_id: string }>();
    const blockedByAuthor = await env.DB_META_C000.prepare(
      `SELECT target_account_id AS account_id
       FROM blocks
       WHERE account_id = ?
         AND target_account_id IN (${placeholders})`,
    ).bind(accountId, ...allFollowerIds).all<{ account_id: string }>();
    const domainBlockedBy = statusCheck.author_domain === null
      ? { results: [] as Array<{ account_id: string }> }
      : await env.DB_META_C000.prepare(
        `SELECT account_id
         FROM user_domain_blocks
         WHERE lower(domain) = lower(?)
           AND account_id IN (${placeholders})`,
      ).bind(statusCheck.author_domain, ...allFollowerIds)
        .all<{ account_id: string }>();

    const excludeSet = new Set([
      ...(blockedBy.results ?? []).map((r) => r.account_id),
      ...(mutedBy.results ?? []).map((r) => r.account_id),
      ...(blockedByAuthor.results ?? []).map((r) => r.account_id),
      ...(domainBlockedBy.results ?? []).map((r) => r.account_id),
    ]);

    if (excludeSet.size > 0) {
      followerIds = allFollowerIds.filter((id) => !excludeSet.has(id));
      console.log(`Filtered ${excludeSet.size} blocked/muted followers from fanout for status ${statusId}`);
    }
  }

  if (followerIds.length === 0 && !canBroadcastPublicly && !hasContinuation) {
    timer.stopWithMetadata({ status: 'no_followers', followerCount: 0 });
    return;
  }

  // Send streaming events to all local followers
  if (followerIds.length > 0) {
    const placeholders = followerIds.map(() => '?').join(',');
    const userRows = await measureAsync(
      'timelineFanout.db.loadUsers',
      () => env.DB_META_C000.prepare(
        `SELECT recipient_user.id, recipient_user.account_id
         FROM users recipient_user
         JOIN accounts recipient ON recipient.id = recipient_user.account_id
         WHERE recipient_user.account_id IN (${placeholders})
           AND recipient_user.disabled = 0
           AND recipient_user.approved = 1
           AND recipient.domain IS NULL
           AND recipient.suspended_at IS NULL
           AND recipient.memorial = 0
           AND NOT EXISTS (
             SELECT 1 FROM blocks viewer_block
             WHERE viewer_block.account_id = recipient_user.account_id
               AND viewer_block.target_account_id = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM blocks author_block
             WHERE author_block.account_id = ?
               AND author_block.target_account_id = recipient_user.account_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM mutes viewer_mute
             WHERE viewer_mute.account_id = recipient_user.account_id
               AND viewer_mute.target_account_id = ?
               AND (
                 viewer_mute.expires_at IS NULL
                 OR viewer_mute.expires_at > ?
               )
           )
           AND NOT EXISTS (
             SELECT 1 FROM user_domain_blocks viewer_domain_block
             WHERE viewer_domain_block.account_id = recipient_user.account_id
               AND ? IS NOT NULL
               AND lower(viewer_domain_block.domain) = lower(?)
           )`,
      )
        .bind(
          ...followerIds,
          accountId,
          accountId,
          accountId,
          relationshipCheckAt,
          statusCheck.author_domain,
          statusCheck.author_domain,
        )
        .all<{ id: string; account_id: string }>(),
      { followerCount: followerIds.length }
    );

    if (userRows.results && userRows.results.length > 0) {
      // A user's relationship with a nested reblog/quote author can differ
      // from their relationship with the wrapper author. Build one payload per
      // account so nested objects are checked for the actual recipient.
      const payloadByAccountId = new Map<string, Promise<string | null>>();
      // Plain statuses have no audience-dependent nested object. The outer
      // status and each recipient were already rechecked above, so one
      // authorized serialization can safely serve every recipient without
      // multiplying D1 reads by the follower count.
      const sharedPayload = hasAudienceSensitiveNestedStatus
        ? null
        : buildStatusStreamingPayload(
            env.DB_META_C000,
            statusId,
            env.INSTANCE_DOMAIN,
            {
              kind: 'account',
              accountId: userRows.results[0].account_id,
            },
          );
      const projections: Array<{ feedKey: string; payload: string }> = [];
      const streamPromises = userRows.results.map(async (user) => {
        let payloadPromise = sharedPayload
          ?? payloadByAccountId.get(user.account_id);
        if (!payloadPromise) {
          payloadPromise = buildStatusStreamingPayload(
            env.DB_META_C000,
            statusId,
            env.INSTANCE_DOMAIN,
            { kind: 'account', accountId: user.account_id },
          );
          payloadByAccountId.set(user.account_id, payloadPromise);
        }
        const statusPayload = await payloadPromise;
        if (!statusPayload) return;

        projections.push({ feedKey: `home:${user.account_id}`, payload: statusPayload });

        await sendStreamEvent(user.id, {
          event: 'update',
          payload: statusPayload,
          stream: ['user'],
        }).catch((err) => {
          console.error(`Failed to send stream event to user ${user.id}:`, err);
        });
      });

      await measureAsync(
        'timelineFanout.streaming.sendEvents',
        () => Promise.allSettled(streamPromises),
        { userCount: userRows.results.length }
      );

      if (projections.length > 0) {
        const now = new Date().toISOString();
        await env.DB_META_C000.batch(projections.map((projection) => env.DB_META_C000.prepare(
          `INSERT INTO search_feed_entries (
             feed_key, entity_id, source_ordinal, sort_at_ms,
             author_summary_json, entity_summary_json, visibility, audience_json,
             source_version, tombstoned_at, graph_version, created_at, updated_at
           ) VALUES (?1, ?2, 0, ?3, '{}', ?4, ?5, '{}', ?6, NULL, NULL, ?7, ?7)
           ON CONFLICT(feed_key, entity_id) DO UPDATE SET
             entity_summary_json = excluded.entity_summary_json,
             source_version = excluded.source_version,
             tombstoned_at = NULL,
             updated_at = excluded.updated_at
           WHERE excluded.source_version >= search_feed_entries.source_version`,
        ).bind(
          projection.feedKey,
          statusId,
          statusCheck.sort_at_ms,
          projection.payload,
          statusCheck.visibility,
          statusCheck.source_version,
          now,
        )));
        await Promise.allSettled(projections.map((projection) => projectRealtimeFeed({
          feedKey: projection.feedKey,
          entityId: statusId,
          sourceOrdinal: 0,
          sortAtMs: statusCheck.sort_at_ms,
          sourceVersion: statusCheck.source_version,
          snapshotJson: projection.payload,
        })));
      }

      console.log(
        `Sent streaming events for status ${statusId} to ${userRows.results.length} users`,
      );
    }
  }

  if (hasContinuation && allFollowerIds.length > 0) {
    await env.QUEUE_INTERNAL.send({
      type: 'timeline_fanout',
      statusId,
      accountId,
      cursor: allFollowerIds[allFollowerIds.length - 1],
    });
  }

  timer.stopWithMetadata({
    status: 'success',
    followerCount: followerIds.length
  });

  // Public streams receive a separately authorized payload. In particular, a
  // public wrapper cannot expose an unlisted/private or moderated nested post.
  const publicStatusPayload = canBroadcastPublicly
    ? await measureAsync(
        'timelineFanout.buildPublicStreamingPayload',
        () => buildStatusStreamingPayload(
          env.DB_META_C000,
          statusId,
          env.INSTANCE_DOMAIN,
          { kind: 'public' },
        ),
        { statusId },
      )
    : null;

  // Broadcast to public/local streams — INDEPENDENT of follower count
  if (publicStatusPayload) {
    const publicStreams = ['public'];
    if (statusCheck.author_domain === null) publicStreams.push('public:local');

    console.log(`Broadcasting to public streams: ${publicStreams.join(', ')} for status ${statusId}`);
    await sendStreamEvent('__public__', {
      event: 'update',
      payload: publicStatusPayload,
      stream: publicStreams,
    }).catch((err) => {
      console.error(`Failed to broadcast to public streams:`, err);
    });
    const publicFeedKeys = [
      'public:all:all',
      ...(statusCheck.author_domain === null ? ['public:local:all'] : ['public:remote:all']),
    ];
    const now = new Date().toISOString();
    await env.DB_META_C000.batch(publicFeedKeys.map((feedKey) => env.DB_META_C000.prepare(
      `INSERT INTO search_feed_entries (
         feed_key, entity_id, source_ordinal, sort_at_ms,
         author_summary_json, entity_summary_json, visibility, audience_json,
         source_version, tombstoned_at, graph_version, created_at, updated_at
       ) VALUES (?1, ?2, 0, ?3, '{}', ?4, ?5, '{}', ?6, NULL, NULL, ?7, ?7)
       ON CONFLICT(feed_key, entity_id) DO UPDATE SET
         entity_summary_json = excluded.entity_summary_json,
         source_version = excluded.source_version,
         tombstoned_at = NULL,
         updated_at = excluded.updated_at
       WHERE excluded.source_version >= search_feed_entries.source_version`,
    ).bind(feedKey, statusId, statusCheck.sort_at_ms, publicStatusPayload, statusCheck.visibility, statusCheck.source_version, now)));
    await Promise.allSettled(publicFeedKeys.map((feedKey) => projectRealtimeFeed({
      feedKey,
      entityId: statusId,
      sourceOrdinal: 0,
      sortAtMs: statusCheck.sort_at_ms,
      sourceVersion: statusCheck.source_version,
      snapshotJson: publicStatusPayload,
    })));
  }
}
