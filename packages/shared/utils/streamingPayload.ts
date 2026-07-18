/**
 * Streaming Status Payload Builder
 *
 * Builds a Mastodon API-compatible status JSON string for streaming events.
 * Composes DB queries, emoji fetching, media serialization, and account/status
 * serialization into a single reusable function.
 *
 * Used by the timeline fanout handler for both follower and public streaming.
 */

import type { AccountRow, StatusRow } from '../types/db';
import {
  serializeAccount,
  serializeStatus,
  serializeMediaAttachment,
} from '../serializers/mastodonSerializer';
import { fetchEmojisForStatus, fetchAccountEmojis } from './emoji';
import {
  canBroadcastStatusToPublicStreams,
  canEmbedQuote,
  canSurfaceStatus,
  canViewStatus,
} from '../permissions';

export type StatusStreamingAudience =
  | { kind: 'public' }
  | { kind: 'account'; accountId: string };

/** Shape of the JOIN query result for status + account */
interface StatusWithAccountJoin {
  id: string;
  uri: string;
  object_type: 'Note' | 'Article';
  title: string;
  poll_id: string | null;
  content: string;
  visibility: string;
  sensitive: number | boolean;
  content_warning: string | null;
  language: string | null;
  url: string | null;
  created_at: string;
  in_reply_to_id: string | null;
  in_reply_to_account_id: string | null;
  reblog_of_id: string | null;
  quote_id: string | null;
  quote_approval_status: string | null;
  quote_policy: string | null;
  reblogs_count: number;
  favourites_count: number;
  replies_count: number;
  edited_at: string | null;
  deleted_at: string | null;
  // Account fields from JOIN
  account_id: string;
  username: string;
  domain: string | null;
  display_name: string | null;
  account_note: string | null;
  account_url: string | null;
  account_uri: string | null;
  avatar_url: string | null;
  header_url: string | null;
  locked: number | boolean;
  bot: number | boolean;
  followers_count: number;
  following_count: number;
  statuses_count: number;
  account_created_at: string;
  account_suspended_at: string | null;
  account_silenced_at: string | null;
  account_memorial: number | boolean;
  viewer_follows_author: number | boolean;
  viewer_is_mentioned: number | boolean;
  viewer_mutes_author: number | boolean;
  viewer_blocks_author: number | boolean;
  viewer_blocks_author_domain: number | boolean;
  author_blocks_viewer: number | boolean;
}

const STATUS_ACCOUNT_QUERY = `
  SELECT s.id, s.uri, s.object_type, s.title, s.poll_id, s.content, s.visibility, s.sensitive,
         s.content_warning, s.language, s.url, s.created_at,
         s.in_reply_to_id, s.in_reply_to_account_id, s.reblog_of_id,
         s.quote_id, s.quote_approval_status, s.quote_policy,
         s.reblogs_count, s.favourites_count, s.replies_count,
         s.edited_at, s.deleted_at,
         a.id AS account_id, a.username, a.domain, a.display_name,
         a.note AS account_note, a.url AS account_url, a.uri AS account_uri,
         a.avatar_url, a.header_url, a.locked, a.bot,
         a.followers_count, a.following_count, a.statuses_count,
         a.created_at AS account_created_at,
         a.suspended_at AS account_suspended_at,
         a.silenced_at AS account_silenced_at,
         a.memorial AS account_memorial,
         EXISTS (
           SELECT 1 FROM follows streaming_follow
           WHERE streaming_follow.account_id = ?2
             AND streaming_follow.target_account_id = a.id
         ) AS viewer_follows_author,
         EXISTS (
           SELECT 1 FROM mentions streaming_mention
           WHERE streaming_mention.status_id = s.id
             AND streaming_mention.account_id = ?2
         ) AS viewer_is_mentioned,
         EXISTS (
           SELECT 1 FROM mutes streaming_mute
           WHERE streaming_mute.account_id = ?2
             AND streaming_mute.target_account_id = a.id
             AND (
               streaming_mute.expires_at IS NULL
               OR streaming_mute.expires_at > ?3
             )
         ) AS viewer_mutes_author,
         EXISTS (
           SELECT 1 FROM blocks streaming_viewer_block
           WHERE streaming_viewer_block.account_id = ?2
             AND streaming_viewer_block.target_account_id = a.id
         ) AS viewer_blocks_author,
         EXISTS (
           SELECT 1 FROM user_domain_blocks streaming_domain_block
           WHERE streaming_domain_block.account_id = ?2
             AND a.domain IS NOT NULL
             AND lower(streaming_domain_block.domain) = lower(a.domain)
         ) AS viewer_blocks_author_domain,
         EXISTS (
           SELECT 1 FROM blocks streaming_author_block
           WHERE streaming_author_block.account_id = a.id
             AND streaming_author_block.target_account_id = ?2
         ) AS author_blocks_viewer
  FROM statuses s
  JOIN accounts a ON a.id = s.account_id
  WHERE s.id = ?1`;

interface MediaAttachmentRecord {
  id: string;
  type: string | null;
  file_key: string;
  thumbnail_key: string | null;
  file_content_type: string | null;
  description: string | null;
  blurhash: string | null;
  width: number | null;
  height: number | null;
}

function isTrue(value: number | boolean): boolean {
  return value === true || value === 1;
}

function viewerAccountIdForAudience(
  audience: StatusStreamingAudience,
): string | null {
  return audience.kind === 'account' ? audience.accountId : null;
}

function canIncludeStatusForAudience(
  row: StatusWithAccountJoin,
  audience: StatusStreamingAudience,
): boolean {
  if (audience.kind === 'public') {
    return canBroadcastStatusToPublicStreams({
      visibility: row.visibility,
      statusDeleted: row.deleted_at !== null,
      authorSuspended: row.account_suspended_at !== null,
      authorSilenced: row.account_silenced_at !== null,
    });
  }

  const statusViewable = canViewStatus({
    visibility: row.visibility,
    viewerAccountId: audience.accountId,
    authorAccountId: row.account_id,
    viewerFollowsAuthor: isTrue(row.viewer_follows_author),
    viewerIsMentioned: isTrue(row.viewer_is_mentioned),
    authorBlocksViewer: isTrue(row.author_blocks_viewer),
    statusDeleted: row.deleted_at !== null,
  });

  return canSurfaceStatus({
    statusViewable,
    authorSuspended: row.account_suspended_at !== null,
    authorSilenced: row.account_silenced_at !== null,
    viewerIsAuthor: audience.accountId === row.account_id,
    viewerFollowsAuthor: isTrue(row.viewer_follows_author),
    viewerMutesAuthor: isTrue(row.viewer_mutes_author),
    viewerBlocksAuthor: isTrue(row.viewer_blocks_author),
    viewerBlocksAuthorDomain: isTrue(row.viewer_blocks_author_domain),
    authorBlocksViewer: isTrue(row.author_blocks_viewer),
  });
}

function canIncludeQuoteForAudience(
  row: StatusWithAccountJoin,
  audience: StatusStreamingAudience,
): boolean {
  if (audience.kind === 'account') {
    return canIncludeStatusForAudience(row, audience);
  }

  const statusViewable = canViewStatus({
    visibility: row.visibility,
    viewerAccountId: null,
    authorAccountId: row.account_id,
    viewerFollowsAuthor: false,
    viewerIsMentioned: false,
    authorBlocksViewer: false,
    statusDeleted: row.deleted_at !== null,
  });
  return canSurfaceStatus({
    statusViewable,
    authorSuspended: row.account_suspended_at !== null,
    authorSilenced: row.account_silenced_at !== null,
    viewerIsAuthor: false,
    viewerFollowsAuthor: false,
    viewerMutesAuthor: false,
    viewerBlocksAuthor: false,
    viewerBlocksAuthorDomain: false,
    authorBlocksViewer: false,
  });
}

async function fetchStatusForAudience(
  db: D1Database,
  statusId: string,
  audience: StatusStreamingAudience,
  checkedAt: string,
): Promise<StatusWithAccountJoin | null> {
  return db
    .prepare(STATUS_ACCOUNT_QUERY)
    .bind(statusId, viewerAccountIdForAudience(audience), checkedAt)
    .first<StatusWithAccountJoin>();
}

/**
 * Convert a JOIN result row into an AccountRow-compatible shape
 * for use with serializeAccount().
 */
function toAccountRow(row: StatusWithAccountJoin): AccountRow {
  return {
    id: row.account_id,
    username: row.username,
    domain: row.domain,
    display_name: row.display_name || '',
    note: row.account_note || '',
    uri: row.account_uri || '',
    url: row.account_url,
    avatar_url: row.avatar_url || '',
    avatar_static_url: '',
    header_url: row.header_url || '',
    header_static_url: '',
    locked: typeof row.locked === 'boolean' ? (row.locked ? 1 : 0) : (row.locked as number),
    bot: typeof row.bot === 'boolean' ? (row.bot ? 1 : 0) : (row.bot as number),
    discoverable: null,
    manually_approves_followers: 0,
    statuses_count: row.statuses_count || 0,
    followers_count: row.followers_count || 0,
    following_count: row.following_count || 0,
    last_status_at: null,
    created_at: row.account_created_at,
    updated_at: row.account_created_at,
    suspended_at: row.account_suspended_at,
    silenced_at: row.account_silenced_at,
    memorial: isTrue(row.account_memorial) ? 1 : 0,
    moved_to_account_id: null,
  } as AccountRow;
}

/**
 * Convert a JOIN result row into a StatusRow-compatible shape
 * for use with serializeStatus().
 */
function toStatusRow(row: StatusWithAccountJoin): StatusRow {
  return {
    id: row.id,
    uri: row.uri,
    url: row.url,
    object_type: row.object_type,
    title: row.title,
    account_id: row.account_id,
    in_reply_to_id: row.in_reply_to_id,
    in_reply_to_account_id: row.in_reply_to_account_id,
    reblog_of_id: row.reblog_of_id ?? null,
    text: '',
    content: row.content || '',
    content_warning: row.content_warning || '',
    visibility: row.visibility,
    sensitive: typeof row.sensitive === 'boolean' ? (row.sensitive ? 1 : 0) : (row.sensitive as number),
    language: row.language || '',
    conversation_id: null,
    reply: 0,
    replies_count: row.replies_count || 0,
    reblogs_count: row.reblogs_count || 0,
    favourites_count: row.favourites_count || 0,
    local: 0,
    federated_at: null,
    edited_at: row.edited_at,
    deleted_at: row.deleted_at ?? null,
    poll_id: row.poll_id,
    quote_id: row.quote_id,
    quote_approval_status: row.quote_approval_status,
    quote_policy: row.quote_policy,
    emoji_tags: null,
    created_at: row.created_at,
    updated_at: row.created_at,
  } as StatusRow;
}

/**
 * Build a Mastodon API-compatible status JSON string for streaming.
 *
 * Fetches the status + account from DB, resolves emojis, media attachments,
 * and reblogs. Returns null if the status is not found.
 */
export async function buildStatusStreamingPayload(
  db: D1Database,
  statusId: string,
  instanceDomain: string,
  audience: StatusStreamingAudience,
): Promise<string | null> {
  const checkedAt = new Date().toISOString();
  const statusRow = await fetchStatusForAudience(
    db,
    statusId,
    audience,
    checkedAt,
  );

  if (!statusRow || !canIncludeStatusForAudience(statusRow, audience)) {
    return null;
  }

  // Fetch emojis and media in parallel
  const [statusEmojis, accountEmojis, mediaResult] = await Promise.all([
    fetchEmojisForStatus(db, statusId, instanceDomain),
    fetchAccountEmojis(db, statusRow.account_id, instanceDomain),
    db
      .prepare(
        'SELECT id, type, file_key, thumbnail_key, file_content_type, description, blurhash, width, height FROM media_attachments WHERE status_id = ?',
      )
      .bind(statusId)
      .all<MediaAttachmentRecord>(),
  ]);

  // Serialize media attachments
  const mediaAttachments = (mediaResult.results ?? []).map((m) => {
    const fk = m.file_key;
    const isRemote = fk.startsWith('http');
    return serializeMediaAttachment(
      {
        id: m.id,
        status_id: statusId,
        account_id: statusRow.account_id,
        file_key: fk,
        file_content_type: m.file_content_type || '',
        file_size: 0,
        thumbnail_key: m.thumbnail_key,
        remote_url: isRemote ? fk : null,
        description: m.description || '',
        blurhash: m.blurhash,
        width: m.width,
        height: m.height,
        type: m.type || 'image',
        created_at: '',
        updated_at: '',
      },
      instanceDomain,
    );
  });

  // Serialize account and status
  const accountRow = toAccountRow(statusRow);
  const account = serializeAccount(accountRow, {
    instanceDomain,
    emojis: accountEmojis,
  });

  const sRow = toStatusRow(statusRow);
  let status = serializeStatus(sRow, {
    account,
    mediaAttachments,
    emojis: statusEmojis,
  });

  // Nested statuses are independently authorized for the actual audience.
  // A wrapper can remain visible while its reblog/quote target is hidden.
  if (statusRow.reblog_of_id) {
    const origRow = await fetchStatusForAudience(
      db,
      statusRow.reblog_of_id,
      audience,
      checkedAt,
    );

    if (origRow && canIncludeStatusForAudience(origRow, audience)) {
      const origAccountEmojis = await fetchAccountEmojis(
        db,
        origRow.account_id,
        instanceDomain,
      );
      const origAccountRow = toAccountRow(origRow);
      const origAccount = serializeAccount(origAccountRow, {
        instanceDomain,
        emojis: origAccountEmojis,
      });
      const origStatusRow = toStatusRow(origRow);
      const reblog = serializeStatus(origStatusRow, { account: origAccount });

      // Re-serialize with reblog attached
      status = serializeStatus(sRow, {
        account,
        mediaAttachments,
        emojis: statusEmojis,
        reblog,
      });
    }
  }

  if (canEmbedQuote({
    quoteStatusId: statusRow.quote_id,
    quoteApprovalStatus: statusRow.quote_approval_status,
  })) {
    const quoteStatusId = statusRow.quote_id;
    if (!quoteStatusId) return JSON.stringify(status);
    const quoteRow = await fetchStatusForAudience(
      db,
      quoteStatusId,
      audience,
      checkedAt,
    );

    if (quoteRow && canIncludeQuoteForAudience(quoteRow, audience)) {
      const quoteAccountEmojis = await fetchAccountEmojis(
        db,
        quoteRow.account_id,
        instanceDomain,
      );
      const quoteAccount = serializeAccount(toAccountRow(quoteRow), {
        instanceDomain,
        emojis: quoteAccountEmojis,
      });
      const quote = serializeStatus(toStatusRow(quoteRow), {
        account: quoteAccount,
      });

      status = serializeStatus(sRow, {
        account,
        mediaAttachments,
        emojis: statusEmojis,
        reblog: status.reblog,
        quote,
      });
    }
  }

  return JSON.stringify(status);
}
