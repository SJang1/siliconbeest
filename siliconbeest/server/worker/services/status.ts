import { generateUlid } from '../utils/ulid';
import { parseContent, type ParsedContent } from '../utils/contentParser';
import { AppError } from '../middleware/errorHandler';
import type { StatusRow, PollRow, AccountRow, CustomEmojiRow } from '../types/db';
import { serializePoll } from '../utils/mastodonSerializer';

// ----------------------------------------------------------------
// getStatusById
// ----------------------------------------------------------------

export async function getStatusById(db: D1Database, id: string): Promise<StatusRow | null> {
  return (await db
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
  db: D1Database,
  statusId: string,
  accountId: string,
): Promise<DeleteStatusResult> {
  const status = await getStatusById(db, statusId);
  if (!status) throw new AppError(404, 'Record not found');
  if (status.account_id !== accountId) throw new AppError(403, 'This action is not allowed');

  const now = new Date().toISOString();
  const stmts = [
    db.prepare('UPDATE statuses SET deleted_at = ?1 WHERE id = ?2').bind(now, statusId),
    db.prepare('UPDATE accounts SET statuses_count = MAX(0, statuses_count - 1) WHERE id = ?1').bind(accountId),
  ];
  if (status.in_reply_to_id) {
    stmts.push(
      db.prepare('UPDATE statuses SET replies_count = MAX(0, replies_count - 1) WHERE id = ?1').bind(status.in_reply_to_id),
    );
  }
  await db.batch(stmts);

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

export async function getContext(db: D1Database, statusId: string): Promise<ContextResult> {
  // Verify status exists
  const status = await db
    .prepare('SELECT id, in_reply_to_id FROM statuses WHERE id = ?1 AND deleted_at IS NULL')
    .bind(statusId)
    .first();
  if (!status) throw new AppError(404, 'Record not found');

  // Ancestors: walk up the in_reply_to chain
  const ancestors: Record<string, unknown>[] = [];
  let currentId = status.in_reply_to_id as string | null;
  const visited = new Set<string>();

  while (currentId && !visited.has(currentId) && ancestors.length < 40) {
    visited.add(currentId);
    const ancestor = await db
      .prepare(`${STATUS_JOIN_SQL} WHERE s.id = ?1 AND s.deleted_at IS NULL`)
      .bind(currentId)
      .first();
    if (!ancestor) break;
    ancestors.unshift(ancestor as Record<string, unknown>);
    currentId = (ancestor.in_reply_to_id as string) || null;
  }

  // Build set of ancestor IDs + current status to exclude from descendants
  const excludeIds = new Set<string>([statusId, ...ancestors.map((a) => a.id as string)]);

  // Descendants: BFS through replies
  const descendantRows: Record<string, unknown>[] = [];
  const seenDescendantIds = new Set<string>();
  const queue = [statusId];
  let depth = 0;

  while (queue.length > 0 && depth < 10 && descendantRows.length < 60) {
    const batch = queue.splice(0, queue.length);
    const ph = batch.map(() => '?').join(',');
    const { results: replyRows } = await db
      .prepare(
        `${STATUS_JOIN_SQL}
         WHERE s.in_reply_to_id IN (${ph})
           AND s.deleted_at IS NULL
         ORDER BY s.created_at ASC
         LIMIT 60`,
      )
      .bind(...batch)
      .all();
    for (const r of (replyRows ?? []) as Record<string, unknown>[]) {
      const rid = r.id as string;
      if (!seenDescendantIds.has(rid) && !excludeIds.has(rid)) {
        seenDescendantIds.add(rid);
        descendantRows.push(r);
        queue.push(rid);
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
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<FavouriteResult> {
  const existing = await db
    .prepare('SELECT id FROM favourites WHERE account_id = ?1 AND status_id = ?2')
    .bind(accountId, statusId)
    .first();

  if (existing) return { created: false };

  const now = new Date().toISOString();
  const id = generateUlid();
  await db.batch([
    db.prepare('INSERT INTO favourites (id, account_id, status_id, created_at) VALUES (?1, ?2, ?3, ?4)').bind(
      id,
      accountId,
      statusId,
      now,
    ),
    db.prepare('UPDATE statuses SET favourites_count = favourites_count + 1 WHERE id = ?1').bind(statusId),
  ]);

  return { created: true };
}

// ----------------------------------------------------------------
// unfavouriteStatus
// ----------------------------------------------------------------

export async function unfavouriteStatus(
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<void> {
  const existing = await db
    .prepare('SELECT id FROM favourites WHERE account_id = ?1 AND status_id = ?2')
    .bind(accountId, statusId)
    .first();

  if (existing) {
    await db.batch([
      db.prepare('DELETE FROM favourites WHERE id = ?1').bind(existing.id as string),
      db.prepare('UPDATE statuses SET favourites_count = MAX(0, favourites_count - 1) WHERE id = ?1').bind(statusId),
    ]);
  }
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
  db: D1Database,
  domain: string,
  accountId: string,
  username: string,
  statusId: string,
): Promise<ReblogResult> {
  // Check if already reblogged
  const existing = await db
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

  // Fetch original status visibility for the reblog row
  const originalStatus = await db
    .prepare('SELECT visibility FROM statuses WHERE id = ?1 AND deleted_at IS NULL')
    .bind(statusId)
    .first();
  const visibility = originalStatus ? (originalStatus.visibility as string) : 'public';

  await db.batch([
    db.prepare(
      `INSERT INTO statuses (id, uri, url, account_id, reblog_of_id, visibility, local, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)`,
    ).bind(reblogId, reblogUri, null, accountId, statusId, visibility, now),
    db.prepare('UPDATE statuses SET reblogs_count = reblogs_count + 1 WHERE id = ?1').bind(statusId),
    db.prepare('UPDATE accounts SET statuses_count = statuses_count + 1 WHERE id = ?1').bind(accountId),
  ]);

  // Add reblog to own home timeline immediately
  await db
    .prepare('INSERT OR IGNORE INTO home_timeline_entries (status_id, account_id, created_at) VALUES (?1, ?2, ?3)')
    .bind(reblogId, accountId, now)
    .run();

  return { reblogId, reblogUri, created: true };
}

// ----------------------------------------------------------------
// unreblogStatus
// ----------------------------------------------------------------

export interface UnreblogResult {
  reblogId: string | null;
}

export async function unreblogStatus(
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<UnreblogResult> {
  const reblog = await db
    .prepare('SELECT id FROM statuses WHERE reblog_of_id = ?1 AND account_id = ?2 AND deleted_at IS NULL')
    .bind(statusId, accountId)
    .first();

  if (reblog) {
    const now = new Date().toISOString();
    await db.batch([
      db.prepare('UPDATE statuses SET deleted_at = ?1 WHERE id = ?2').bind(now, reblog.id as string),
      db.prepare('UPDATE statuses SET reblogs_count = MAX(0, reblogs_count - 1) WHERE id = ?1').bind(statusId),
      db.prepare('UPDATE accounts SET statuses_count = MAX(0, statuses_count - 1) WHERE id = ?1').bind(accountId),
    ]);
    return { reblogId: reblog.id as string };
  }

  return { reblogId: null };
}

// ----------------------------------------------------------------
// bookmarkStatus
// ----------------------------------------------------------------

export async function bookmarkStatus(
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<void> {
  const existing = await db
    .prepare('SELECT id FROM bookmarks WHERE account_id = ?1 AND status_id = ?2')
    .bind(accountId, statusId)
    .first();

  if (!existing) {
    const now = new Date().toISOString();
    const id = generateUlid();
    await db
      .prepare('INSERT INTO bookmarks (id, account_id, status_id, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(id, accountId, statusId, now)
      .run();
  }
}

// ----------------------------------------------------------------
// unbookmarkStatus
// ----------------------------------------------------------------

export async function unbookmarkStatus(
  db: D1Database,
  accountId: string,
  statusId: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM bookmarks WHERE account_id = ?1 AND status_id = ?2')
    .bind(accountId, statusId)
    .run();
}

// ----------------------------------------------------------------
// createStatus
// ----------------------------------------------------------------

export interface CreateStatusData {
  text: string;
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
}

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
  visibility: string;
  sensitive: number;
  spoilerText: string;
  language: string;
}

export async function createStatus(
  db: D1Database,
  domain: string,
  accountId: string,
  username: string,
  data: CreateStatusData,
): Promise<CreateStatusResult> {
  const now = new Date().toISOString();
  const statusId = generateUlid();
  const visibility = data.visibility || 'public';
  const sensitive = data.sensitive ? 1 : 0;
  const spoilerText = data.spoilerText || '';
  const language = data.language || 'en';
  const statusText = (data.text || '').trim();
  const mediaIds = data.mediaIds || [];

  const parsed = parseContent(statusText, domain);
  const content = parsed.html;
  const statusUri = `https://${domain}/users/${username}/statuses/${statusId}`;
  const statusUrl = `https://${domain}/@${username}/${statusId}`;

  // -- Reply resolution --
  let inReplyToId: string | null = null;
  let inReplyToAccountId: string | null = null;
  let conversationId: string | null = null;
  let isReply = 0;

  if (data.inReplyToId) {
    const parent = await db
      .prepare('SELECT id, account_id, conversation_id FROM statuses WHERE id = ?1 AND deleted_at IS NULL')
      .bind(data.inReplyToId)
      .first();
    if (parent) {
      inReplyToId = parent.id as string;
      inReplyToAccountId = parent.account_id as string;
      conversationId = (parent.conversation_id as string) || null;
      isReply = 1;
    }
  }

  // -- FEP-e232: Resolve quote post --
  let quoteId: string | null = null;
  let quoteUri: string | null = null;
  if (data.quoteId) {
    const quoted = await db
      .prepare('SELECT id, uri FROM statuses WHERE id = ?1 AND deleted_at IS NULL')
      .bind(data.quoteId)
      .first();
    if (quoted) {
      quoteId = quoted.id as string;
      quoteUri = quoted.uri as string;
    }
  }

  // -- Conversation creation/lookup --
  let conversationApUri: string | null = null;
  if (!conversationId) {
    conversationId = generateUlid();
    const year = now.substring(0, 4);
    conversationApUri = `tag:${domain},${year}:objectId=${conversationId}:objectType=Conversation`;
    await db
      .prepare('INSERT INTO conversations (id, ap_uri, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)')
      .bind(conversationId, conversationApUri, now)
      .run();
  } else {
    const convRow = await db
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
    const emojiRows = await db
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

  // -- Main batch: status INSERT + account count + reply count + media linking + home_timeline --
  const stmts: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO statuses (id, uri, url, account_id, in_reply_to_id, in_reply_to_account_id, text, content, content_warning, visibility, sensitive, language, conversation_id, reply, quote_id, local, emoji_tags, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 1, ?16, ?17, ?17)`,
    ).bind(
      statusId,
      statusUri,
      statusUrl,
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
      emojiTagsJson,
      now,
    ),
    db.prepare('UPDATE accounts SET statuses_count = statuses_count + 1, last_status_at = ?1 WHERE id = ?2').bind(
      now,
      accountId,
    ),
  ];

  if (inReplyToId) {
    stmts.push(db.prepare('UPDATE statuses SET replies_count = replies_count + 1 WHERE id = ?1').bind(inReplyToId));
  }

  for (const mediaId of mediaIds) {
    stmts.push(
      db.prepare('UPDATE media_attachments SET status_id = ?1 WHERE id = ?2 AND account_id = ?3').bind(
        statusId,
        mediaId,
        accountId,
      ),
    );
  }

  stmts.push(
    db.prepare('INSERT OR IGNORE INTO home_timeline_entries (id, account_id, status_id, created_at) VALUES (?1, ?2, ?3, ?4)').bind(
      generateUlid(),
      accountId,
      statusId,
      now,
    ),
  );

  await db.batch(stmts);

  // -- Poll creation --
  let pollData: ReturnType<typeof serializePoll> | null = null;
  if (data.pollOptions && data.pollOptions.length >= 2) {
    const pollId = generateUlid();
    const expiresAt = data.pollExpiresIn ? new Date(Date.now() + data.pollExpiresIn * 1000).toISOString() : null;
    const multiple = data.pollMultiple ? 1 : 0;
    const optionsJson = JSON.stringify(
      data.pollOptions.filter((o: string) => o.trim()).map((title: string) => ({ title, votes_count: 0 })),
    );

    await db.batch([
      db.prepare(
        `INSERT INTO polls (id, status_id, expires_at, multiple, votes_count, voters_count, options, created_at)
         VALUES (?1, ?2, ?3, ?4, 0, 0, ?5, ?6)`,
      ).bind(pollId, statusId, expiresAt, multiple, optionsJson, now),
      db.prepare('UPDATE statuses SET poll_id = ?1 WHERE id = ?2').bind(pollId, statusId),
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
    const existingTags = await db
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
      await db
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
      await db.prepare(query).bind(...values).run();
    }

    if (allTagIds.length > 0) {
      const values: unknown[] = [];
      let query = 'INSERT OR IGNORE INTO status_tags (status_id, tag_id) VALUES ';
      allTagIds.forEach((tagId, idx) => {
        if (idx > 0) query += ', ';
        query += `(?${idx * 2 + 1}, ?${idx * 2 + 2})`;
        values.push(statusId, tagId);
      });
      await db.prepare(query).bind(...values).run();
    }
  }

  // -- Local mention resolution (batch SELECT + batch INSERT) --
  const localMentions: LocalMention[] = [];
  const localParsedMentions = parsed.mentions.filter((m) => !m.domain);

  if (localParsedMentions.length > 0) {
    const localUsernames = localParsedMentions.map((m) => m.username);
    const localAccounts = await db
      .prepare(
        `SELECT id, uri, url, inbox_url, domain, username FROM accounts WHERE username IN (${localUsernames.map(() => '?').join(',')}) AND domain IS NULL`,
      )
      .bind(...localUsernames)
      .all<Record<string, unknown>>();

    const localAccountMap = new Map<string, Record<string, unknown>>();
    localAccounts.results.forEach((acc) => {
      localAccountMap.set(acc.username as string, acc);
    });

    const mentionsToInsert: Array<[string, string, string, string]> = [];

    for (const mention of localParsedMentions) {
      const accountRow = localAccountMap.get(mention.username);
      if (!accountRow) continue;

      const mentionedAccountId = accountRow.id as string;
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
      await db.prepare(query).bind(...values).run();
    }
  }

  return {
    statusId,
    statusUri,
    statusUrl,
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
  db: D1Database,
  domain: string,
  statusId: string,
  accountId: string,
  data: EditStatusData,
): Promise<EditStatusResult> {
  // Fetch existing status
  const row = await db
    .prepare('SELECT * FROM statuses WHERE id = ?1 AND deleted_at IS NULL')
    .bind(statusId)
    .first();

  if (!row) throw new AppError(404, 'Record not found');
  if (row.account_id !== accountId) throw new AppError(403, 'This action is not allowed');

  const now = new Date().toISOString();
  const statusText = data.text !== undefined ? data.text.trim() : (row.text as string);
  const sensitive = data.sensitive !== undefined ? (data.sensitive ? 1 : 0) : (row.sensitive as number);
  const spoilerText = data.spoilerText !== undefined ? data.spoilerText : (row.content_warning as string) || '';
  const language = data.language !== undefined ? data.language : (row.language as string) || 'en';
  const mediaIds = data.mediaIds || [];

  const parsed = parseContent(statusText, domain);
  const content = parsed.html;

  // Save current state as an edit history snapshot before applying changes
  const { results: currentMedia } = await db
    .prepare('SELECT * FROM media_attachments WHERE status_id = ?1')
    .bind(statusId)
    .all();
  const mediaSnapshot = (currentMedia ?? []).map((m: any) => ({
    id: m.id,
    type: m.type || 'image',
    url: `https://${domain}/media/${m.file_key}`,
    preview_url: m.thumbnail_key
      ? `https://${domain}/media/${m.thumbnail_key}`
      : `https://${domain}/media/${m.file_key}`,
    description: m.description || null,
    blurhash: m.blurhash || null,
  }));

  await db
    .prepare(
      `INSERT INTO status_edits (id, status_id, content, spoiler_text, sensitive, media_attachments_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      generateUlid(),
      statusId,
      (row.content as string) || '',
      (row.content_warning as string) || '',
      row.sensitive as number,
      JSON.stringify(mediaSnapshot),
      (row.edited_at as string) || (row.created_at as string),
    )
    .run();

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
    const emojiRows = await db
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

  // Main update batch: status fields + media attachments
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE statuses SET text = ?1, content = ?2, content_warning = ?3, sensitive = ?4, language = ?5, emoji_tags = ?6, edited_at = ?7, updated_at = ?7 WHERE id = ?8`,
      )
      .bind(statusText, content, spoilerText, sensitive, language, emojiTagsJson, now, statusId),
  ];

  for (const mediaId of mediaIds) {
    stmts.push(
      db
        .prepare('UPDATE media_attachments SET status_id = ?1 WHERE id = ?2 AND account_id = ?3')
        .bind(statusId, mediaId, accountId),
    );
  }

  await db.batch(stmts);

  // -- Hashtag batch upsert (same pattern as createStatus) --
  const hashtags = parsed.tags;
  await db.prepare('DELETE FROM status_tags WHERE status_id = ?1').bind(statusId).run();

  if (hashtags.length > 0) {
    const existingTags = await db
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
      await db
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
      await db.prepare(query).bind(...values).run();
    }

    if (allTagIds.length > 0) {
      const values: unknown[] = [];
      let query = 'INSERT OR IGNORE INTO status_tags (status_id, tag_id) VALUES ';
      allTagIds.forEach((tagId, idx) => {
        if (idx > 0) query += ', ';
        query += `(?${idx * 2 + 1}, ?${idx * 2 + 2})`;
        values.push(statusId, tagId);
      });
      await db.prepare(query).bind(...values).run();
    }
  }

  // -- Mention re-processing (batch pattern from createStatus) --
  await db.prepare('DELETE FROM mentions WHERE status_id = ?1').bind(statusId).run();

  const localMentions: LocalMention[] = [];
  const localParsedMentions = parsed.mentions.filter((m) => !m.domain);

  if (localParsedMentions.length > 0) {
    const localUsernames = localParsedMentions.map((m) => m.username);
    const localAccounts = await db
      .prepare(
        `SELECT id, uri, url, inbox_url, domain, username FROM accounts WHERE username IN (${localUsernames.map(() => '?').join(',')}) AND domain IS NULL`,
      )
      .bind(...localUsernames)
      .all<Record<string, unknown>>();

    const localAccountMap = new Map<string, Record<string, unknown>>();
    localAccounts.results.forEach((acc) => {
      localAccountMap.set(acc.username as string, acc);
    });

    const mentionsToInsert: Array<[string, string, string, string]> = [];

    for (const mention of localParsedMentions) {
      const accountRow = localAccountMap.get(mention.username);
      if (!accountRow) continue;

      const mentionedAccountId = accountRow.id as string;
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
      await db.prepare(query).bind(...values).run();
    }
  }

  // Fetch updated status and media for response
  const updatedStatus = (await db
    .prepare('SELECT * FROM statuses WHERE id = ?1')
    .bind(statusId)
    .first()) as StatusRow;

  const { results: mediaResults } = await db
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
