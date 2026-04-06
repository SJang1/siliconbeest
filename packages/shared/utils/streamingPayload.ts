/**
 * Streaming Status Payload Builder
 *
 * Builds a Mastodon API-compatible status JSON string for streaming events.
 * Composes DB queries, emoji fetching, media serialization, and account/status
 * serialization into a single reusable function.
 *
 * Used by the timeline fanout handler for both follower and public streaming.
 */

import type { AccountRow, StatusRow, MediaAttachmentRow } from '../types/db';
import { serializeAccount, serializeStatus, serializeMediaAttachment } from '../serializers/mastodonSerializer';
import { fetchEmojisForStatus, fetchAccountEmojis } from './emoji';

/** Shape of the JOIN query result for status + account */
interface StatusWithAccountJoin {
  id: string;
  uri: string;
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
}

const STATUS_ACCOUNT_QUERY = `
  SELECT s.id, s.uri, s.content, s.visibility, s.sensitive,
         s.content_warning, s.language, s.url, s.created_at,
         s.in_reply_to_id, s.in_reply_to_account_id, s.reblog_of_id,
         s.reblogs_count, s.favourites_count, s.replies_count,
         s.edited_at,
         a.id AS account_id, a.username, a.domain, a.display_name,
         a.note AS account_note, a.url AS account_url, a.uri AS account_uri,
         a.avatar_url, a.header_url, a.locked, a.bot,
         a.followers_count, a.following_count, a.statuses_count,
         a.created_at AS account_created_at
  FROM statuses s
  JOIN accounts a ON a.id = s.account_id
  WHERE s.id = ?`;

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
    suspended_at: null,
    silenced_at: null,
    memorial: 0,
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
    poll_id: null,
    quote_id: null,
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
): Promise<string | null> {
  const statusRow = await db
    .prepare(STATUS_ACCOUNT_QUERY)
    .bind(statusId)
    .first<StatusWithAccountJoin>();

  if (!statusRow) return null;

  // Fetch emojis and media in parallel
  const [statusEmojis, accountEmojis, mediaResult] = await Promise.all([
    fetchEmojisForStatus(db, statusId, instanceDomain),
    fetchAccountEmojis(db, statusRow.account_id, instanceDomain),
    db
      .prepare(
        'SELECT id, type, file_key, thumbnail_key, file_content_type, description, blurhash, width, height FROM media_attachments WHERE status_id = ?',
      )
      .bind(statusId)
      .all(),
  ]);

  // Serialize media attachments
  const mediaAttachments = (mediaResult.results ?? []).map((m: any) => {
    const fk = m.file_key as string;
    const isRemote = fk.startsWith('http');
    return serializeMediaAttachment(
      {
        id: m.id as string,
        status_id: statusId,
        account_id: statusRow.account_id,
        file_key: fk,
        file_content_type: (m.file_content_type as string) || '',
        file_size: 0,
        thumbnail_key: (m.thumbnail_key as string) || null,
        remote_url: isRemote ? fk : null,
        description: (m.description as string) || '',
        blurhash: (m.blurhash as string) || null,
        width: m.width as number | null,
        height: m.height as number | null,
        type: (m.type as string) || 'image',
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

  // Resolve reblog if applicable
  if (statusRow.reblog_of_id) {
    const origRow = await db
      .prepare(
        `${STATUS_ACCOUNT_QUERY} AND s.deleted_at IS NULL`,
      )
      .bind(statusRow.reblog_of_id)
      .first<StatusWithAccountJoin>();

    if (origRow) {
      const origAccountEmojis = await fetchAccountEmojis(db, origRow.account_id, instanceDomain);
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

  return JSON.stringify(status);
}
