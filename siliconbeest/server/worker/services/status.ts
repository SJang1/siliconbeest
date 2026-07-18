import { env } from 'cloudflare:workers';
import { generateUlid } from '../utils/ulid';
import { parseArticleContent, parseContent, type ParsedContent } from '../utils/contentParser';
import { AppError } from '../middleware/errorHandler';
import { sanitizeLocale } from '../utils/locales';
import { sanitizeHtml, sanitizePlainText } from '../utils/sanitize';
import type {
  StatusRow,
  PollRow,
  AccountRow,
  CustomEmojiRow,
  MediaAttachmentRow,
} from '../types/db';
import { serializePoll } from '../utils/mastodonSerializer';
import { normalizeQuotePolicy, type QuotePolicy } from '../../../../packages/shared/utils/quotePolicy';
import {
  constrainQuoteVisibility,
  type StatusVisibility,
} from '../../../../packages/shared/permissions';
import {
  assertMediaAttachmentsAttachable,
  assertPollVoteAllowedForRecord,
  assertStatusMutationAllowedForRecord,
  assertStatusRebloggable,
  canQuoteStatusRecord,
  canSurfaceStatusToViewer,
  canViewStatusRecord,
  resolveLocalStatusCreationVisibility,
  type PollVotePermissionRecord,
  type StatusMutationPermissionRecord,
  type StatusPermissionRecord,
  type StatusQuotePermissionRecord,
} from './permissions';

// ----------------------------------------------------------------
// getStatusById
// ----------------------------------------------------------------

export async function getStatusById(id: string): Promise<StatusRow | null> {
  return (await env.DB
    .prepare('SELECT * FROM statuses WHERE id = ? AND deleted_at IS NULL LIMIT 1')
    .bind(id)
    .first()) as StatusRow | null;
}

// ----------------------------------------------------------------
// deleteStatus
// ----------------------------------------------------------------

export interface DeleteStatusResult {
  status: StatusRow;
}

export async function deleteStatus(
  statusId: string,
  accountId: string,
): Promise<DeleteStatusResult> {
  const status = await getStatusById(statusId);
  assertStatusMutationAllowedForRecord(status, accountId, 'delete');

  const now = new Date().toISOString();
  const deleted = await env.DB.prepare(
    `UPDATE statuses
     SET deleted_at = ?1
     WHERE id = ?2
       AND account_id = ?3
       AND deleted_at IS NULL
       AND local = 1`,
  ).bind(now, statusId, accountId).run();
  if ((deleted.meta?.changes ?? 0) !== 1) {
    throw new AppError(404, 'Record not found');
  }

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare('UPDATE accounts SET statuses_count = MAX(0, statuses_count - 1) WHERE id = ?1').bind(accountId),
  ];
  if (status.in_reply_to_id) {
    stmts.push(
      env.DB.prepare('UPDATE statuses SET replies_count = MAX(0, replies_count - 1) WHERE id = ?1').bind(status.in_reply_to_id),
    );
  }
  if (status.reblog_of_id) {
    stmts.push(
      env.DB.prepare(
        'UPDATE statuses SET reblogs_count = MAX(0, reblogs_count - 1) WHERE id = ?1',
      ).bind(status.reblog_of_id),
    );
  }
  await env.DB.batch(stmts);

  return { status };
}

// ----------------------------------------------------------------
// getContext
// ----------------------------------------------------------------

const STATUS_JOIN_SQL = `
  SELECT s.*,
    a.username AS account_username, a.domain AS account_domain,
    a.display_name AS account_display_name, a.note AS account_note,
    a.uri AS account_uri, a.url AS account_url,
    a.avatar_url AS account_avatar_url, a.avatar_static_url AS account_avatar_static_url,
    a.header_url AS account_header_url, a.header_static_url AS account_header_static_url,
    a.locked AS account_locked, a.bot AS account_bot, a.discoverable AS account_discoverable,
    a.followers_count AS account_followers_count, a.following_count AS account_following_count,
    a.statuses_count AS account_statuses_count, a.last_status_at AS account_last_status_at,
    a.created_at AS account_created_at, a.emoji_tags AS account_emoji_tags
  FROM statuses s
  JOIN accounts a ON a.id = s.account_id
`;

export interface ContextResult {
  ancestors: Record<string, unknown>[];
  descendants: Record<string, unknown>[];
}

export async function getContext(
  statusId: string,
  viewerAccountId: string | null = null,
): Promise<ContextResult> {
  // Verify status exists
  const status = await env.DB
    .prepare('SELECT id, account_id, visibility, deleted_at, in_reply_to_id FROM statuses WHERE id = ?1')
    .bind(statusId)
    .first<StatusPermissionRecord & { in_reply_to_id: string | null }>();
  if (!status || !await canViewStatusRecord(status, viewerAccountId)) {
    throw new AppError(404, 'Record not found');
  }

  // Ancestors: walk up the in_reply_to chain
  const ancestors: Record<string, unknown>[] = [];
  let currentId = status.in_reply_to_id;
  const visitedAncestorIds = new Set<string>();

  while (
    currentId
    && !visitedAncestorIds.has(currentId)
    && visitedAncestorIds.size < 40
  ) {
    visitedAncestorIds.add(currentId);
    const ancestor = await env.DB
      .prepare(`${STATUS_JOIN_SQL} WHERE s.id = ?1 AND s.deleted_at IS NULL`)
      .bind(currentId)
      .first();
    if (!ancestor) break;
    currentId = (ancestor.in_reply_to_id as string) || null;
    if (await canSurfaceStatusToViewer(ancestor.id as string, viewerAccountId)) {
      ancestors.unshift(ancestor);
    }
  }

  // Build set of ancestor IDs + current status to exclude from descendants
  const excludeIds = new Set<string>([statusId, ...visitedAncestorIds]);

  // Descendants: BFS through replies
  const descendantRows: Record<string, unknown>[] = [];
  const seenDescendantIds = new Set<string>();
  const queue = [statusId];
  let depth = 0;

  while (queue.length > 0 && depth < 10 && descendantRows.length < 60) {
    const batch = queue.splice(0, queue.length);
    const ph = batch.map(() => '?').join(',');
    const { results: replyRows } = await env.DB
      .prepare(
        `${STATUS_JOIN_SQL}
         WHERE s.in_reply_to_id IN (${ph})
           AND s.deleted_at IS NULL
         ORDER BY s.created_at ASC
         LIMIT 60`,
      )
      .bind(...batch)
      .all();
    for (const r of replyRows ?? []) {
      const rid = r.id as string;
      if (!seenDescendantIds.has(rid) && !excludeIds.has(rid)) {
        seenDescendantIds.add(rid);
        queue.push(rid);
        if (await canSurfaceStatusToViewer(rid, viewerAccountId)) {
          descendantRows.push(r);
        }
      }
    }
    depth++;
  }

  return { ancestors, descendants: descendantRows };
}

// ----------------------------------------------------------------
// favouriteStatus
// ----------------------------------------------------------------

export interface FavouriteResult {
  created: boolean;
}

export async function favouriteStatus(
  accountId: string,
  statusId: string,
): Promise<FavouriteResult> {
  const existing = await env.DB
    .prepare('SELECT id FROM favourites WHERE account_id = ?1 AND status_id = ?2')
    .bind(accountId, statusId)
    .first();

  if (existing) return { created: false };

  const now = new Date().toISOString();
  const id = generateUlid();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO favourites (id, account_id, status_id, created_at) VALUES (?1, ?2, ?3, ?4)').bind(
      id,
      accountId,
      statusId,
      now,
    ),
    env.DB.prepare('UPDATE statuses SET favourites_count = favourites_count + 1 WHERE id = ?1').bind(statusId),
  ]);

  return { created: true };
}

// ----------------------------------------------------------------
// unfavouriteStatus
// ----------------------------------------------------------------

export async function unfavouriteStatus(
  accountId: string,
  statusId: string,
): Promise<boolean> {
  const existing = await env.DB
    .prepare('SELECT id FROM favourites WHERE account_id = ?1 AND status_id = ?2')
    .bind(accountId, statusId)
    .first();

  if (existing) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM favourites WHERE id = ?1').bind(existing.id as string),
      env.DB.prepare('UPDATE statuses SET favourites_count = MAX(0, favourites_count - 1) WHERE id = ?1').bind(statusId),
    ]);
    return true;
  }
  return false;
}

// ----------------------------------------------------------------
// reblogStatus
// ----------------------------------------------------------------

export interface ReblogResult {
  reblogId: string;
  reblogUri: string;
  created: boolean;
}

export async function reblogStatus(
  domain: string,
  accountId: string,
  username: string,
  statusId: string,
): Promise<ReblogResult> {
  await assertStatusRebloggable(statusId, accountId);

  // Check if already reblogged
  const existing = await env.DB
    .prepare('SELECT id FROM statuses WHERE reblog_of_id = ?1 AND account_id = ?2 AND deleted_at IS NULL')
    .bind(statusId, accountId)
    .first();

  if (existing) {
    return {
      reblogId: existing.id as string,
      reblogUri: `https://${domain}/users/${username}/statuses/${existing.id}/activity`,
      created: false,
    };
  }

  const now = new Date().toISOString();
  const reblogId = generateUlid();
  const reblogUri = `https://${domain}/users/${username}/statuses/${reblogId}/activity`;

  const inserted = await env.DB.prepare(
    `INSERT INTO statuses
       (id, uri, url, account_id, reblog_of_id, visibility, local, created_at, updated_at)
     SELECT ?1, ?2, NULL, ?3, s.id, s.visibility, 1, ?4, ?4
     FROM statuses s
     JOIN accounts original_author ON original_author.id = s.account_id
     WHERE s.id = ?5
       AND s.deleted_at IS NULL
       AND s.visibility IN ('public', 'unlisted')
       AND original_author.suspended_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM statuses existing_reblog
         WHERE existing_reblog.reblog_of_id = s.id
           AND existing_reblog.account_id = ?3
           AND existing_reblog.deleted_at IS NULL
       )`,
  ).bind(reblogId, reblogUri, accountId, now, statusId).run();
  if ((inserted.meta?.changes ?? 0) !== 1) {
    const concurrent = await env.DB.prepare(
      `SELECT id FROM statuses
       WHERE reblog_of_id = ?1 AND account_id = ?2 AND deleted_at IS NULL
       LIMIT 1`,
    ).bind(statusId, accountId).first<{ id: string }>();
    if (concurrent) {
      return {
        reblogId: concurrent.id,
        reblogUri: `https://${domain}/users/${username}/statuses/${concurrent.id}/activity`,
        created: false,
      };
    }
    throw new AppError(404, 'Record not found');
  }

  await env.DB.batch([
    env.DB.prepare('UPDATE statuses SET reblogs_count = reblogs_count + 1 WHERE id = ?1').bind(statusId),
    env.DB.prepare('UPDATE accounts SET statuses_count = statuses_count + 1 WHERE id = ?1').bind(accountId),
  ]);

  return { reblogId, reblogUri, created: true };
}

// ----------------------------------------------------------------
// unreblogStatus
// ----------------------------------------------------------------

export interface UnreblogResult {
  reblogId: string | null;
}

export async function unreblogStatus(
  accountId: string,
  statusId: string,
): Promise<UnreblogResult> {
  const reblog = await env.DB
    .prepare(
      `SELECT id FROM statuses
       WHERE reblog_of_id = ?1
         AND account_id = ?2
         AND deleted_at IS NULL
         AND local = 1
       LIMIT 1`,
    )
    .bind(statusId, accountId)
    .first<{ id: string }>();

  if (reblog) {
    const now = new Date().toISOString();
    const deleted = await env.DB.prepare(
      `UPDATE statuses
       SET deleted_at = ?1
       WHERE id = ?2
         AND account_id = ?3
         AND reblog_of_id = ?4
         AND deleted_at IS NULL
         AND local = 1`,
    ).bind(now, reblog.id, accountId, statusId).run();
    if ((deleted.meta?.changes ?? 0) !== 1) {
      return { reblogId: null };
    }

    await env.DB.batch([
      env.DB.prepare('UPDATE statuses SET reblogs_count = MAX(0, reblogs_count - 1) WHERE id = ?1').bind(statusId),
      env.DB.prepare('UPDATE accounts SET statuses_count = MAX(0, statuses_count - 1) WHERE id = ?1').bind(accountId),
    ]);
    return { reblogId: reblog.id };
  }

  return { reblogId: null };
}

// ----------------------------------------------------------------
// bookmarkStatus
// ----------------------------------------------------------------

export async function bookmarkStatus(
  accountId: string,
  statusId: string,
): Promise<boolean> {
  const existing = await env.DB
    .prepare('SELECT id FROM bookmarks WHERE account_id = ?1 AND status_id = ?2')
    .bind(accountId, statusId)
    .first();

  if (!existing) {
    const now = new Date().toISOString();
    const id = generateUlid();
    await env.DB
      .prepare('INSERT INTO bookmarks (id, account_id, status_id, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(id, accountId, statusId, now)
      .run();
    return true;
  }
  return false;
}

// ----------------------------------------------------------------
// unbookmarkStatus
// ----------------------------------------------------------------

export async function unbookmarkStatus(
  accountId: string,
  statusId: string,
): Promise<boolean> {
  const result = await env.DB
    .prepare('DELETE FROM bookmarks WHERE account_id = ?1 AND status_id = ?2')
    .bind(accountId, statusId)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

// ----------------------------------------------------------------
// createStatus
// ----------------------------------------------------------------

export interface CreateStatusData {
  text: string;
  objectType?: 'Note' | 'Article';
  title?: string;
  visibility?: string;
  sensitive?: boolean;
  spoilerText?: string;
  inReplyToId?: string;
  mediaIds?: string[];
  language?: string;
  pollOptions?: string[];
  pollExpiresIn?: number;
  pollMultiple?: boolean;
  /** FEP-e232: ID of the status to quote */
  quoteId?: string;
  /** FEP-044f: policy advertised on this status. */
  quotePolicy?: QuotePolicy;
}

export const MAX_ARTICLE_TITLE_CHARACTERS = 200;
export const MAX_ARTICLE_SUMMARY_CHARACTERS = 500;
export const MAX_ARTICLE_CHARACTERS = 100_000;

export interface LocalMention {
  account_id: string;
  actor_uri: string;
  profile_url: string | null;
  acct: string;
  inbox_url: string | null;
}

export interface CreateStatusResult {
  statusId: string;
  statusUri: string;
  statusUrl: string;
  objectType: 'Note' | 'Article';
  title: string;
  content: string;
  parsed: ParsedContent;
  localMentions: LocalMention[];
  hashtags: string[];
  emojiTags: Array<{ shortcode: string; url: string; static_url: string; visible_in_picker: boolean }>;
  pollData: ReturnType<typeof serializePoll> | null;
  conversationApUri: string | null;
  inReplyToId: string | null;
  inReplyToAccountId: string | null;
  quoteId: string | null;
  quoteUri: string | null;
  quoteUrl: string | null;
  quoteAuthorizationUri: string | null;
  quoteApprovalStatus: string;
  quoteRequestUri: string | null;
  quotePolicy: QuotePolicy;
  visibility: StatusVisibility;
  sensitive: number;
  spoilerText: string;
  language: string;
}

export async function createStatus(
  domain: string,
  accountId: string,
  username: string,
  data: CreateStatusData,
): Promise<CreateStatusResult> {
  const now = new Date().toISOString();
  const statusId = generateUlid();
  let visibility = await resolveLocalStatusCreationVisibility(
    accountId,
    data.visibility ?? 'public',
  );
  const sensitive = data.sensitive ? 1 : 0;
  const requestedSummary = data.spoilerText || '';
  const language = sanitizeLocale(data.language, 'en');
  const statusText = (data.text || '').trim();
  const objectType = data.objectType === 'Article' ? 'Article' : 'Note';
  const title = objectType === 'Article' ? sanitizePlainText(data.title || '') : '';
  const spoilerText = objectType === 'Article' ? sanitizeHtml(requestedSummary) : requestedSummary;
  if (objectType === 'Article' && !title) {
    throw new AppError(422, 'Validation failed', 'Article title is required');
  }
  if (title.length > MAX_ARTICLE_TITLE_CHARACTERS) {
    throw new AppError(422, 'Validation failed', 'Article title is too long');
  }
  if (objectType === 'Article' && spoilerText.length > MAX_ARTICLE_SUMMARY_CHARACTERS) {
    throw new AppError(422, 'Validation failed', 'Article summary is too long');
  }
  if (objectType === 'Article' && statusText.length > MAX_ARTICLE_CHARACTERS) {
    throw new AppError(422, 'Validation failed', 'Article body is too long');
  }
  if (objectType === 'Article' && data.pollOptions?.length) {
    throw new AppError(422, 'Validation failed', 'Articles cannot contain polls');
  }
  const mediaIds = data.mediaIds || [];
  let quotePolicy = normalizeQuotePolicy(data.quotePolicy);
  if (!data.quotePolicy) {
    const pref = await env.DB.prepare(
      'SELECT default_quote_policy FROM users WHERE account_id = ?1 LIMIT 1',
    ).bind(accountId).first<{ default_quote_policy: string | null }>();
    quotePolicy = normalizeQuotePolicy(pref?.default_quote_policy);
  }

  const parsed = objectType === 'Article'
    ? parseArticleContent(statusText, domain)
    : parseContent(statusText, domain);
  const content = parsed.html;
  const statusUri = `https://${domain}/users/${username}/statuses/${statusId}`;
  const statusUrl = `https://${domain}/@${username}/${statusId}`;

  // -- Reply resolution --
  let inReplyToId: string | null = null;
  let inReplyToAccountId: string | null = null;
  let conversationId: string | null = null;
  let isReply = 0;

  if (data.inReplyToId) {
    const parent = await env.DB
      .prepare('SELECT id, account_id, visibility, deleted_at, conversation_id FROM statuses WHERE id = ?1')
      .bind(data.inReplyToId)
      .first<StatusPermissionRecord & { conversation_id: string | null }>();
    if (!parent || !await canViewStatusRecord(parent, accountId)) {
      throw new AppError(404, 'Record not found');
    }
    inReplyToId = parent.id;
    inReplyToAccountId = parent.account_id;
    conversationId = parent.conversation_id;
    isReply = 1;
  }

  // -- FEP-e232: Resolve quote post --
  let quoteId: string | null = null;
  let quoteUri: string | null = null;
  let quoteUrl: string | null = null;
  let quoteApprovalStatus = 'none';
  let quoteRequestUri: string | null = null;
  if (data.quoteId) {
    const quoted = await env.DB
      .prepare(`SELECT id, account_id, visibility, deleted_at, quote_policy,
                       quote_policy_automatic_approvals, quote_policy_manual_approvals,
                       uri, url
                FROM statuses WHERE id = ?1`)
      .bind(data.quoteId)
      .first<StatusQuotePermissionRecord & { uri: string; url: string | null }>();
    if (!quoted || !await canViewStatusRecord(quoted, accountId)) {
      throw new AppError(404, 'Record not found');
    }
    const quoteVisibility = constrainQuoteVisibility(visibility, quoted.visibility);
    if (!quoteVisibility || !await canQuoteStatusRecord(quoted, accountId)) {
      throw new AppError(422, 'Validation failed', 'Cannot quote this status');
    }
    visibility = quoteVisibility;
    quoteId = quoted.id;
    quoteUri = quoted.uri;
    quoteUrl = quoted.url || quoteUri;
    quoteApprovalStatus = 'pending';
    quoteRequestUri = `${statusUri}/quote`;
  }

  await assertMediaAttachmentsAttachable(mediaIds, accountId, statusId);

  // -- Conversation creation/lookup --
  let conversationApUri: string | null = null;
  if (!conversationId) {
    conversationId = generateUlid();
    const year = now.substring(0, 4);
    conversationApUri = `tag:${domain},${year}:objectId=${conversationId}:objectType=Conversation`;
    await env.DB
      .prepare('INSERT INTO conversations (id, ap_uri, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)')
      .bind(conversationId, conversationApUri, now)
      .run();
  } else {
    const convRow = await env.DB
      .prepare('SELECT ap_uri FROM conversations WHERE id = ?1')
      .bind(conversationId)
      .first<{ ap_uri: string | null }>();
    conversationApUri = convRow?.ap_uri ?? null;
  }

  // -- Custom emoji detection --
  let emojiTagsJson: string | null = null;
  let resolvedEmojiTags: Array<{ shortcode: string; url: string; static_url: string; visible_in_picker: boolean }> = [];
  const emojiMatches = [
    ...new Set(
      [...(statusText || '').matchAll(/:([a-zA-Z0-9_]+):/g), ...(spoilerText || '').matchAll(/:([a-zA-Z0-9_]+):/g)].map(
        (m) => m[1],
      ),
    ),
  ];
  if (emojiMatches.length > 0) {
    const placeholders = emojiMatches.map(() => '?').join(',');
    const emojiRows = await env.DB
      .prepare(
        `SELECT shortcode, domain, image_key FROM custom_emojis WHERE shortcode IN (${placeholders}) AND (domain IS NULL OR domain = ?${emojiMatches.length + 1})`,
      )
      .bind(...emojiMatches, domain)
      .all<{ shortcode: string; domain: string | null; image_key: string }>();
    if (emojiRows.results.length > 0) {
      resolvedEmojiTags = emojiRows.results.map((e) => {
        const isLocal = !e.domain || e.domain === domain;
        const url = isLocal ? `https://${domain}/media/${e.image_key}` : e.image_key;
        return { shortcode: e.shortcode, url, static_url: url, visible_in_picker: false };
      });
      emojiTagsJson = JSON.stringify(
        resolvedEmojiTags.map((e) => ({ shortcode: e.shortcode, url: e.url, static_url: e.static_url })),
      );
    }
  }

  const claimedMediaIds: string[] = [];
  for (const mediaId of mediaIds) {
    const claimed = await env.DB.prepare(
      `UPDATE media_attachments
       SET status_id = ?1
       WHERE id = ?2
         AND account_id = ?3
         AND status_id IS NULL`,
    ).bind(statusId, mediaId, accountId).run();
    if ((claimed.meta?.changes ?? 0) !== 1) {
      if (claimedMediaIds.length > 0) {
        const placeholders = claimedMediaIds.map(() => '?').join(', ');
        await env.DB.prepare(
          `UPDATE media_attachments
           SET status_id = NULL
           WHERE status_id = ?
             AND account_id = ?
             AND id IN (${placeholders})`,
        ).bind(statusId, accountId, ...claimedMediaIds).run();
      }
      throw new AppError(422, 'Validation failed', 'Invalid media attachment');
    }
    claimedMediaIds.push(mediaId);
  }

  // -- Main batch: status INSERT + account count + reply count --
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO statuses (id, uri, url, object_type, title, account_id, in_reply_to_id, in_reply_to_account_id, text, content, content_warning, visibility, sensitive, language, conversation_id, reply, quote_id, quote_approval_status, quote_request_uri, quote_policy, local, emoji_tags, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, 1, ?21, ?22, ?22)`,
    ).bind(
      statusId,
      statusUri,
      statusUrl,
      objectType,
      title,
      accountId,
      inReplyToId,
      inReplyToAccountId,
      statusText,
      content,
      spoilerText,
      visibility,
      sensitive,
      language,
      conversationId,
      isReply,
      quoteId,
      quoteApprovalStatus,
      quoteRequestUri,
      quotePolicy,
      emojiTagsJson,
      now,
    ),
    env.DB.prepare('UPDATE accounts SET statuses_count = statuses_count + 1, last_status_at = ?1 WHERE id = ?2').bind(
      now,
      accountId,
    ),
  ];

  if (inReplyToId) {
    stmts.push(env.DB.prepare('UPDATE statuses SET replies_count = replies_count + 1 WHERE id = ?1').bind(inReplyToId));
  }

  try {
    await env.DB.batch(stmts);
  } catch (error) {
    if (claimedMediaIds.length > 0) {
      const placeholders = claimedMediaIds.map(() => '?').join(', ');
      await env.DB.prepare(
        `UPDATE media_attachments
         SET status_id = NULL
         WHERE status_id = ?
           AND account_id = ?
           AND id IN (${placeholders})`,
      ).bind(statusId, accountId, ...claimedMediaIds).run();
    }
    throw error;
  }

  // -- Poll creation --
  let pollData: ReturnType<typeof serializePoll> | null = null;
  if (data.pollOptions && data.pollOptions.length >= 2) {
    const pollId = generateUlid();
    const expiresAt = data.pollExpiresIn ? new Date(Date.now() + data.pollExpiresIn * 1000).toISOString() : null;
    const multiple = data.pollMultiple ? 1 : 0;
    const optionsJson = JSON.stringify(
      data.pollOptions.filter((o: string) => o.trim()).map((title: string) => ({ title, votes_count: 0 })),
    );

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO polls (id, status_id, expires_at, multiple, votes_count, voters_count, options, created_at)
         VALUES (?1, ?2, ?3, ?4, 0, 0, ?5, ?6)`,
      ).bind(pollId, statusId, expiresAt, multiple, optionsJson, now),
      env.DB.prepare('UPDATE statuses SET poll_id = ?1 WHERE id = ?2').bind(pollId, statusId),
    ]);

    pollData = serializePoll(
      {
        id: pollId,
        status_id: statusId,
        expires_at: expiresAt,
        multiple,
        votes_count: 0,
        voters_count: 0,
        options: optionsJson,
        created_at: now,
      },
      { voted: false, ownVotes: [] },
    );
  }

  // -- Hashtag batch upsert (optimized: batch SELECT + batch INSERT + batch UPDATE) --
  const hashtags = parsed.tags;
  if (hashtags.length > 0) {
    const existingTags = await env.DB
      .prepare(`SELECT id, name FROM tags WHERE name IN (${hashtags.map(() => '?').join(',')})`)
      .bind(...hashtags)
      .all<{ id: string; name: string }>();

    const existingTagMap = new Map(existingTags.results.map((t) => [t.name, t.id]));
    const newTagsToInsert: Array<{ id: string; name: string }> = [];
    const existingTagIdsToUpdate: string[] = [];
    const allTagIds: string[] = [];

    for (const tag of hashtags) {
      let tagId: string;
      if (existingTagMap.has(tag)) {
        tagId = existingTagMap.get(tag)!;
        existingTagIdsToUpdate.push(tagId);
      } else {
        tagId = generateUlid();
        newTagsToInsert.push({ id: tagId, name: tag });
      }
      allTagIds.push(tagId);
    }

    if (existingTagIdsToUpdate.length > 0) {
      const placeholders = existingTagIdsToUpdate.map(() => '?').join(',');
      await env.DB
        .prepare(`UPDATE tags SET last_status_at = ?1, updated_at = ?1 WHERE id IN (${placeholders})`)
        .bind(now, ...existingTagIdsToUpdate)
        .run();
    }

    if (newTagsToInsert.length > 0) {
      const values: unknown[] = [];
      let query = 'INSERT INTO tags (id, name, display_name, created_at, updated_at) VALUES ';
      newTagsToInsert.forEach((tag, idx) => {
        if (idx > 0) query += ', ';
        query += `(?${idx * 4 + 1}, ?${idx * 4 + 2}, ?${idx * 4 + 3}, ?${idx * 4 + 4}, ?${idx * 4 + 4})`;
        values.push(tag.id, tag.name, tag.name, now);
      });
      await env.DB.prepare(query).bind(...values).run();
    }

    if (allTagIds.length > 0) {
      const values: unknown[] = [];
      let query = 'INSERT OR IGNORE INTO status_tags (status_id, tag_id) VALUES ';
      allTagIds.forEach((tagId, idx) => {
        if (idx > 0) query += ', ';
        query += `(?${idx * 2 + 1}, ?${idx * 2 + 2})`;
        values.push(statusId, tagId);
      });
      await env.DB.prepare(query).bind(...values).run();
    }
  }

  // -- Local mention resolution (batch SELECT + batch INSERT) --
  const localMentions: LocalMention[] = [];
  const localParsedMentions = parsed.mentions.filter((m) => !m.domain);

  if (localParsedMentions.length > 0) {
    const localUsernames = localParsedMentions.map((m) => m.username);
    // Typed mentions resolve case-insensitively (COLLATE NOCASE, binding the
    // raw typed usernames — never pre-lowercased): '@alice' must reach stored
    // 'Alice'. Registration uniqueness is NOCASE (migration 0030), so at most
    // one account matches. The mention/notification then uses the row's
    // canonical id/uri/url, keeping ActivityPub identity exact-case.
    const localAccounts = await env.DB
      .prepare(
        `SELECT id, uri, url, inbox_url, domain, username FROM accounts WHERE username COLLATE NOCASE IN (${localUsernames.map(() => '?').join(',')}) AND domain IS NULL`,
      )
      .bind(...localUsernames)
      .all<Record<string, unknown>>();

    const localAccountMap = new Map<string, Record<string, unknown>>();
    localAccounts.results.forEach((acc) => {
      localAccountMap.set((acc.username as string).toLowerCase(), acc);
    });

    const mentionsToInsert: Array<[string, string, string, string]> = [];
    const seenAccountIds = new Set<string>();

    for (const mention of localParsedMentions) {
      const accountRow = localAccountMap.get(mention.username.toLowerCase());
      if (!accountRow) continue;

      const mentionedAccountId = accountRow.id as string;
      // '@Alice' and '@alice' typed in one status fold to the same account —
      // keep only the first so one mention row / one notification is created.
      if (seenAccountIds.has(mentionedAccountId)) continue;
      seenAccountIds.add(mentionedAccountId);
      const mentionId = generateUlid();
      mentionsToInsert.push([mentionId, statusId, mentionedAccountId, now]);

      localMentions.push({
        account_id: mentionedAccountId,
        actor_uri: (accountRow.uri as string) || '',
        profile_url: (accountRow.url as string) || null,
        acct: mention.acct,
        inbox_url: (accountRow.inbox_url as string) || null,
      });
    }

    if (mentionsToInsert.length > 0) {
      const values: unknown[] = [];
      let query = 'INSERT OR IGNORE INTO mentions (id, status_id, account_id, created_at) VALUES ';
      mentionsToInsert.forEach((mention, idx) => {
        if (idx > 0) query += ', ';
        query += `(?${idx * 4 + 1}, ?${idx * 4 + 2}, ?${idx * 4 + 3}, ?${idx * 4 + 4})`;
        values.push(...mention);
      });
      await env.DB.prepare(query).bind(...values).run();
    }
  }

  return {
    statusId,
    statusUri,
    statusUrl,
    objectType,
    title,
    content,
    parsed,
    localMentions,
    hashtags,
    emojiTags: resolvedEmojiTags,
    pollData,
    conversationApUri,
    inReplyToId,
    inReplyToAccountId,
    quoteId,
    quoteUri,
    quoteUrl,
    quoteAuthorizationUri: null,
    quoteApprovalStatus,
    quoteRequestUri,
    quotePolicy,
    visibility,
    sensitive,
    spoilerText,
    language,
  };
}

// ----------------------------------------------------------------
// editStatus
// ----------------------------------------------------------------

export interface EditStatusData {
  text?: string;
  objectType?: 'Note' | 'Article';
  title?: string;
  summary?: string;
  sensitive?: boolean;
  spoilerText?: string;
  language?: string;
  mediaIds?: string[];
}

export interface EditStatusResult {
  status: StatusRow;
  content: string;
  hashtags: string[];
  localMentions: LocalMention[];
  mediaAttachments: Record<string, unknown>[];
}

export async function editStatus(
  domain: string,
  statusId: string,
  accountId: string,
  data: EditStatusData,
): Promise<EditStatusResult> {
  // Fetch existing status
  const row = await env.DB
    .prepare('SELECT * FROM statuses WHERE id = ?1 AND deleted_at IS NULL')
    .bind(statusId)
    .first<StatusRow>();
  assertStatusMutationAllowedForRecord(row, accountId, 'edit');

  const now = new Date().toISOString();
  const statusText = data.text !== undefined ? data.text.trim() : row.text;
  const objectType = data.objectType ?? row.object_type;
  if (objectType !== row.object_type) {
    throw new AppError(422, 'Validation failed', 'Status type cannot be changed after publishing');
  }
  const title = objectType === 'Article'
    ? sanitizePlainText(data.title !== undefined ? data.title : row.title)
    : '';
  if (objectType === 'Article' && !title) {
    throw new AppError(422, 'Validation failed', 'Article title is required');
  }
  if (title.length > MAX_ARTICLE_TITLE_CHARACTERS) {
    throw new AppError(422, 'Validation failed', 'Article title is too long');
  }
  if (objectType === 'Article' && statusText.length > MAX_ARTICLE_CHARACTERS) {
    throw new AppError(422, 'Validation failed', 'Article body is too long');
  }
  const sensitive = data.sensitive !== undefined ? (data.sensitive ? 1 : 0) : row.sensitive;
  const requestedSummary = objectType === 'Article'
    ? (data.summary !== undefined ? data.summary : row.content_warning || '')
    : (data.spoilerText !== undefined ? data.spoilerText : row.content_warning || '');
  const spoilerText = objectType === 'Article' ? sanitizeHtml(requestedSummary) : requestedSummary;
  if (objectType === 'Article' && spoilerText.length > MAX_ARTICLE_SUMMARY_CHARACTERS) {
    throw new AppError(422, 'Validation failed', 'Article summary is too long');
  }
  const language = sanitizeLocale(data.language ?? row.language, 'en');
  const mediaIds = data.mediaIds || [];
  await assertMediaAttachmentsAttachable(mediaIds, accountId, statusId);

  const parsed = objectType === 'Article'
    ? parseArticleContent(statusText, domain)
    : parseContent(statusText, domain);
  const content = parsed.html;

  // Save current state as an edit history snapshot before applying changes
  const { results: currentMedia } = await env.DB
    .prepare('SELECT * FROM media_attachments WHERE status_id = ?1')
    .bind(statusId)
    .all<MediaAttachmentRow>();
  const mediaSnapshot = (currentMedia ?? []).map((m) => ({
    id: m.id,
    type: m.type || 'image',
    url: `https://${domain}/media/${m.file_key}`,
    preview_url: m.thumbnail_key
      ? `https://${domain}/media/${m.thumbnail_key}`
      : `https://${domain}/media/${m.file_key}`,
    description: m.description || null,
    blurhash: m.blurhash || null,
  }));

  // -- Custom emoji detection --
  let emojiTagsJson: string | null = null;
  const emojiMatches = [
    ...new Set(
      [...(statusText || '').matchAll(/:([a-zA-Z0-9_]+):/g), ...(spoilerText || '').matchAll(/:([a-zA-Z0-9_]+):/g)].map(
        (m) => m[1],
      ),
    ),
  ];
  if (emojiMatches.length > 0) {
    const placeholders = emojiMatches.map(() => '?').join(',');
    const emojiRows = await env.DB
      .prepare(
        `SELECT shortcode, domain, image_key FROM custom_emojis WHERE shortcode IN (${placeholders}) AND (domain IS NULL OR domain = ?${emojiMatches.length + 1})`,
      )
      .bind(...emojiMatches, domain)
      .all<{ shortcode: string; domain: string | null; image_key: string }>();
    if (emojiRows.results.length > 0) {
      emojiTagsJson = JSON.stringify(
        emojiRows.results.map((e) => {
          const isLocal = !e.domain || e.domain === domain;
          const url = isLocal ? `https://${domain}/media/${e.image_key}` : e.image_key;
          return { shortcode: e.shortcode, url, static_url: url };
        }),
      );
    }
  }

  const updated = await env.DB.prepare(
    `UPDATE statuses
     SET text = ?1, title = ?2, content = ?3, content_warning = ?4, sensitive = ?5,
         language = ?6, emoji_tags = ?7, edited_at = ?8, updated_at = ?8
     WHERE id = ?9
       AND account_id = ?10
       AND deleted_at IS NULL
       AND local = 1
       AND reblog_of_id IS NULL`,
  ).bind(
    statusText,
    title,
    content,
    spoilerText,
    sensitive,
    language,
    emojiTagsJson,
    now,
    statusId,
    accountId,
  ).run();
  if ((updated.meta?.changes ?? 0) !== 1) {
    throw new AppError(404, 'Record not found');
  }

  await env.DB.prepare(
    `INSERT INTO status_edits
       (id, status_id, object_type, title, content, spoiler_text, sensitive, media_attachments_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(
    generateUlid(),
    statusId,
    row.object_type,
    row.title,
    row.content || '',
    row.content_warning || '',
    row.sensitive,
    JSON.stringify(mediaSnapshot),
    row.edited_at || row.created_at,
  ).run();

  for (const mediaId of mediaIds) {
    const attached = await env.DB.prepare(
      `UPDATE media_attachments
       SET status_id = ?1
       WHERE id = ?2
         AND account_id = ?3
         AND (status_id IS NULL OR status_id = ?1)`,
    ).bind(statusId, mediaId, accountId).run();
    if ((attached.meta?.changes ?? 0) !== 1) {
      throw new AppError(422, 'Validation failed', 'Invalid media attachment');
    }
  }

  // -- Hashtag batch upsert (same pattern as createStatus) --
  const hashtags = parsed.tags;
  await env.DB.prepare('DELETE FROM status_tags WHERE status_id = ?1').bind(statusId).run();

  if (hashtags.length > 0) {
    const existingTags = await env.DB
      .prepare(`SELECT id, name FROM tags WHERE name IN (${hashtags.map(() => '?').join(',')})`)
      .bind(...hashtags)
      .all<{ id: string; name: string }>();

    const existingTagMap = new Map(existingTags.results.map((t) => [t.name, t.id]));
    const newTagsToInsert: Array<{ id: string; name: string }> = [];
    const existingTagIdsToUpdate: string[] = [];
    const allTagIds: string[] = [];

    for (const tag of hashtags) {
      let tagId: string;
      if (existingTagMap.has(tag)) {
        tagId = existingTagMap.get(tag)!;
        existingTagIdsToUpdate.push(tagId);
      } else {
        tagId = generateUlid();
        newTagsToInsert.push({ id: tagId, name: tag });
      }
      allTagIds.push(tagId);
    }

    if (existingTagIdsToUpdate.length > 0) {
      const ph = existingTagIdsToUpdate.map(() => '?').join(',');
      await env.DB
        .prepare(`UPDATE tags SET last_status_at = ?1, updated_at = ?1 WHERE id IN (${ph})`)
        .bind(now, ...existingTagIdsToUpdate)
        .run();
    }

    if (newTagsToInsert.length > 0) {
      const values: unknown[] = [];
      let query = 'INSERT INTO tags (id, name, display_name, created_at, updated_at) VALUES ';
      newTagsToInsert.forEach((tag, idx) => {
        if (idx > 0) query += ', ';
        query += `(?${idx * 4 + 1}, ?${idx * 4 + 2}, ?${idx * 4 + 3}, ?${idx * 4 + 4}, ?${idx * 4 + 4})`;
        values.push(tag.id, tag.name, tag.name, now);
      });
      await env.DB.prepare(query).bind(...values).run();
    }

    if (allTagIds.length > 0) {
      const values: unknown[] = [];
      let query = 'INSERT OR IGNORE INTO status_tags (status_id, tag_id) VALUES ';
      allTagIds.forEach((tagId, idx) => {
        if (idx > 0) query += ', ';
        query += `(?${idx * 2 + 1}, ?${idx * 2 + 2})`;
        values.push(statusId, tagId);
      });
      await env.DB.prepare(query).bind(...values).run();
    }
  }

  // -- Mention re-processing (batch pattern from createStatus) --
  await env.DB.prepare('DELETE FROM mentions WHERE status_id = ?1').bind(statusId).run();

  const localMentions: LocalMention[] = [];
  const localParsedMentions = parsed.mentions.filter((m) => !m.domain);

  if (localParsedMentions.length > 0) {
    const localUsernames = localParsedMentions.map((m) => m.username);
    // Typed mentions resolve case-insensitively (COLLATE NOCASE, binding the
    // raw typed usernames — never pre-lowercased): '@alice' must reach stored
    // 'Alice'. Registration uniqueness is NOCASE (migration 0030), so at most
    // one account matches. The mention/notification then uses the row's
    // canonical id/uri/url, keeping ActivityPub identity exact-case.
    const localAccounts = await env.DB
      .prepare(
        `SELECT id, uri, url, inbox_url, domain, username FROM accounts WHERE username COLLATE NOCASE IN (${localUsernames.map(() => '?').join(',')}) AND domain IS NULL`,
      )
      .bind(...localUsernames)
      .all<Record<string, unknown>>();

    const localAccountMap = new Map<string, Record<string, unknown>>();
    localAccounts.results.forEach((acc) => {
      localAccountMap.set((acc.username as string).toLowerCase(), acc);
    });

    const mentionsToInsert: Array<[string, string, string, string]> = [];
    const seenAccountIds = new Set<string>();

    for (const mention of localParsedMentions) {
      const accountRow = localAccountMap.get(mention.username.toLowerCase());
      if (!accountRow) continue;

      const mentionedAccountId = accountRow.id as string;
      // '@Alice' and '@alice' typed in one status fold to the same account —
      // keep only the first so one mention row / one notification is created.
      if (seenAccountIds.has(mentionedAccountId)) continue;
      seenAccountIds.add(mentionedAccountId);
      const mentionId = generateUlid();
      mentionsToInsert.push([mentionId, statusId, mentionedAccountId, now]);

      localMentions.push({
        account_id: mentionedAccountId,
        actor_uri: (accountRow.uri as string) || '',
        profile_url: (accountRow.url as string) || null,
        acct: mention.acct,
        inbox_url: (accountRow.inbox_url as string) || null,
      });
    }

    if (mentionsToInsert.length > 0) {
      const values: unknown[] = [];
      let query = 'INSERT OR IGNORE INTO mentions (id, status_id, account_id, created_at) VALUES ';
      mentionsToInsert.forEach((mention, idx) => {
        if (idx > 0) query += ', ';
        query += `(?${idx * 4 + 1}, ?${idx * 4 + 2}, ?${idx * 4 + 3}, ?${idx * 4 + 4})`;
        values.push(...mention);
      });
      await env.DB.prepare(query).bind(...values).run();
    }
  }

  // Fetch updated status and media for response
  const updatedStatus = (await env.DB
    .prepare('SELECT * FROM statuses WHERE id = ?1')
    .bind(statusId)
    .first()) as StatusRow;

  const { results: mediaResults } = await env.DB
    .prepare('SELECT * FROM media_attachments WHERE status_id = ?1')
    .bind(statusId)
    .all();

  const mediaAttachments = (mediaResults ?? []).map((m: any) => ({
    id: m.id as string,
    type: (m.type as string) || 'image',
    url: `https://${domain}/media/${m.file_key}`,
    preview_url: m.thumbnail_key
      ? `https://${domain}/media/${m.thumbnail_key}`
      : `https://${domain}/media/${m.file_key}`,
    remote_url: (m.remote_url as string) || null,
    text_url: null,
    meta: null,
    description: (m.description as string) || null,
    blurhash: (m.blurhash as string) || null,
  }));

  return {
    status: updatedStatus,
    content,
    hashtags,
    localMentions,
    mediaAttachments,
  };
}

// ----------------------------------------------------------------
// pinStatus
// ----------------------------------------------------------------

export async function pinStatus(
  accountId: string,
  statusId: string,
): Promise<boolean> {
  const status = await env.DB.prepare(
    `SELECT id, account_id, visibility, deleted_at, local, reblog_of_id, pinned
     FROM statuses WHERE id = ?1 LIMIT 1`,
  ).bind(statusId).first<StatusMutationPermissionRecord & { pinned: number | null }>();
  assertStatusMutationAllowedForRecord(status, accountId, 'pin');
  if (status?.pinned === 1) return false;

  const pinned = await env.DB.prepare(
    `UPDATE statuses SET pinned = 1
     WHERE id = ?1
       AND account_id = ?2
       AND deleted_at IS NULL
       AND local = 1
       AND reblog_of_id IS NULL
       AND visibility IN ('public', 'unlisted', 'private')`,
  ).bind(statusId, accountId).run();
  if ((pinned.meta?.changes ?? 0) !== 1) {
    throw new AppError(404, 'Record not found');
  }
  return true;
}

// ----------------------------------------------------------------
// unpinStatus
// ----------------------------------------------------------------

export async function unpinStatus(
  accountId: string,
  statusId: string,
): Promise<boolean> {
  const status = await env.DB.prepare(
    `SELECT id, account_id, visibility, deleted_at, local, reblog_of_id, pinned
     FROM statuses WHERE id = ?1 LIMIT 1`,
  ).bind(statusId).first<StatusMutationPermissionRecord & { pinned: number | null }>();
  assertStatusMutationAllowedForRecord(status, accountId, 'unpin');
  if (status?.pinned !== 1) return false;

  const unpinned = await env.DB.prepare(
    `UPDATE statuses SET pinned = 0
     WHERE id = ?1
       AND account_id = ?2
       AND deleted_at IS NULL
       AND local = 1`,
  ).bind(statusId, accountId).run();
  if ((unpinned.meta?.changes ?? 0) !== 1) {
    throw new AppError(404, 'Record not found');
  }
  return true;
}

// ----------------------------------------------------------------
// muteStatus
// ----------------------------------------------------------------

export async function muteStatus(
  accountId: string,
  statusId: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const id = generateUlid();
  const inserted = await env.DB
    .prepare('INSERT OR IGNORE INTO status_mutes (id, account_id, status_id, created_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(id, accountId, statusId, now)
    .run();
  return (inserted.meta?.changes ?? 0) > 0;
}

// ----------------------------------------------------------------
// unmuteStatus
// ----------------------------------------------------------------

export async function unmuteStatus(
  accountId: string,
  statusId: string,
): Promise<boolean> {
  const removed = await env.DB
    .prepare('DELETE FROM status_mutes WHERE account_id = ?1 AND status_id = ?2')
    .bind(accountId, statusId)
    .run();
  return (removed.meta?.changes ?? 0) > 0;
}

// ----------------------------------------------------------------
// addReaction
// ----------------------------------------------------------------

export interface AddReactionResult {
  reactionId: string;
  customEmojiId: string | null;
  created: boolean;
}

export async function addReaction(
  accountId: string,
  statusId: string,
  emoji: string,
  domain?: string,
): Promise<AddReactionResult> {
  // Validate custom emoji exists
  let customEmojiId: string | null = null;
  const isCustom = emoji.startsWith(':') && emoji.endsWith(':');

  if (isCustom && domain) {
    const shortcode = emoji.slice(1, -1);
    const row = await env.DB
      .prepare('SELECT * FROM custom_emojis WHERE shortcode = ? AND (domain IS NULL OR domain = ?)')
      .bind(shortcode, domain)
      .first<CustomEmojiRow>();
    if (!row) {
      throw new AppError(422, 'Custom emoji not found');
    }
    customEmojiId = row.id;
  }

  const id = generateUlid();
  const now = new Date().toISOString();

  try {
    await env.DB
      .prepare(
        `INSERT INTO emoji_reactions (id, account_id, status_id, emoji, custom_emoji_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(id, accountId, statusId, emoji, customEmojiId, now)
      .run();
    return { reactionId: id, customEmojiId, created: true };
  } catch {
    // UNIQUE constraint — duplicate reaction, ignore
    return { reactionId: id, customEmojiId, created: false };
  }
}

// ----------------------------------------------------------------
// removeReaction
// ----------------------------------------------------------------

export interface RemoveReactionResult {
  changes: number;
}

export async function removeReaction(
  accountId: string,
  statusId: string,
  emoji: string,
): Promise<RemoveReactionResult> {
  const deleted = await env.DB
    .prepare('DELETE FROM emoji_reactions WHERE account_id = ?1 AND status_id = ?2 AND emoji = ?3')
    .bind(accountId, statusId, emoji)
    .run();

  return { changes: deleted.meta?.changes ?? 0 };
}

// ----------------------------------------------------------------
// votePoll
// ----------------------------------------------------------------

export interface VotePollResult {
  poll: ReturnType<typeof serializePoll>;
}

export async function votePoll(
  accountId: string,
  pollId: string,
  choices: number[],
): Promise<VotePollResult> {
  const row = await env.DB
    .prepare('SELECT * FROM polls WHERE id = ?1')
    .bind(pollId)
    .first<PollRow>();

  if (!row) {
    throw new AppError(404, 'Record not found');
  }

  const parent = await env.DB.prepare(
    `SELECT id, account_id, visibility, deleted_at
     FROM statuses WHERE id = ?1 LIMIT 1`,
  ).bind(row.status_id).first<StatusPermissionRecord>();
  if (!parent) throw new AppError(404, 'Record not found');
  await assertPollVoteAllowedForRecord({
    ...parent,
    expires_at: row.expires_at,
  } satisfies PollVotePermissionRecord, accountId);

  // Parse options to validate choice indices
  let options: Array<string | { title: string; votes_count?: number }>;
  try {
    options = JSON.parse(row.options);
  } catch {
    throw new AppError(500, 'An unexpected error occurred');
  }

  for (const choice of choices) {
    if (!Number.isInteger(choice) || choice < 0 || choice >= options.length) {
      throw new AppError(422, 'Validation failed', 'Invalid choice index');
    }
  }
  if (new Set(choices).size !== choices.length) {
    throw new AppError(422, 'Validation failed', 'Duplicate choice index');
  }

  // Check not multiple if poll doesn't allow it
  if (!row.multiple && choices.length > 1) {
    throw new AppError(422, 'Validation failed', 'Poll does not allow multiple choices');
  }

  // Check not already voted
  const existingVote = await env.DB
    .prepare('SELECT id FROM poll_votes WHERE poll_id = ?1 AND account_id = ?2 LIMIT 1')
    .bind(pollId, accountId)
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
      env.DB.prepare(
        'INSERT INTO poll_votes (id, poll_id, account_id, choice, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
      ).bind(voteId, pollId, accountId, choice, now),
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
    env.DB.prepare(
      'UPDATE polls SET options = ?1, votes_count = votes_count + ?2, voters_count = voters_count + 1 WHERE id = ?3',
    ).bind(JSON.stringify(updatedOptions), choices.length, pollId),
  );

  await env.DB.batch(stmts);

  // Fetch updated poll
  const updated = await env.DB
    .prepare('SELECT * FROM polls WHERE id = ?1')
    .bind(pollId)
    .first<PollRow>();
  if (!updated) throw new AppError(404, 'Record not found');

  return { poll: serializePoll(updated, { voted: true, ownVotes: choices }) };
}
