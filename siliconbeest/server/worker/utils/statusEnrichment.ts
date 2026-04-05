/**
 * Batch-fetch media attachments and interaction states for a list of statuses.
 * Used by all timeline endpoints to avoid N+1 queries.
 */

/* oxlint-disable fp/no-let, fp/no-loop-statements, fp/no-throw-statements, fp/no-try-statements, no-param-reassign */

import type { MediaAttachment as MastodonMediaAttachment, PreviewCard, Poll as MastodonPoll } from '../types/mastodon';
import { serializeMediaAttachment, serializePoll } from './mastodonSerializer';
import type { MediaAttachmentRow, PollRow } from '../types/db';

export type MentionInfo = {
  id: string;
  username: string;
  acct: string;
  url: string;
};

/**
 * Helper to proxy remote emoji URLs through the /proxy endpoint.
 * Treats all remote emoji URLs as JIT-fetched resources.
 */
function proxyEmojiUrl(url: string, instanceDomain: string): string {
  if (!url || !instanceDomain) return url;
  try {
    const parsed = new URL(url);
    // Only proxy external URLs (not local R2 URLs)
    if (parsed.hostname === instanceDomain) return url;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url;
    return `https://${instanceDomain}/proxy?url=${encodeURIComponent(url)}`;
  } catch {
    return url;
  }
}

export type EmojiInfo = {
  shortcode: string;
  url: string;
  static_url: string;
  visible_in_picker: boolean;
};

export type StatusEnrichment = {
  mediaAttachments: MastodonMediaAttachment[];
  favourited: boolean | null;
  reblogged: boolean | null;
  bookmarked: boolean | null;
  reactions: { emoji: string; count: number }[];
  mentions: MentionInfo[];
  card: PreviewCard | null;
  poll: MastodonPoll | null;
  emojis: EmojiInfo[];
  accountEmojis: EmojiInfo[];
};

const EMPTY: StatusEnrichment = {
  mediaAttachments: [],
  favourited: null,
  reblogged: null,
  bookmarked: null,
  reactions: [],
  mentions: [],
  card: null,
  poll: null,
  emojis: [],
  accountEmojis: [],
};

/**
 * Batch-enrich statuses with media, emoji reactions, and interaction states.
 * Runs up to 5 queries in parallel (1 media + 1 reactions + 3 interactions if authenticated).
 */
export async function enrichStatuses(
  db: D1Database,
  domain: string,
  statusIds: string[],
  currentAccountId?: string | null,
  cache?: KVNamespace,
  /** Map of statusId → pollId for statuses that have polls */
  pollIdMap?: Map<string, string>,
): Promise<Map<string, StatusEnrichment>> {
  if (statusIds.length === 0) return new Map();

  const placeholders = statusIds.map(() => '?').join(',');
  const result = new Map<string, StatusEnrichment>();

  // Initialize all entries
  for (const id of statusIds) {
    result.set(id, { ...EMPTY, mediaAttachments: [], reactions: [], mentions: [], card: null, poll: null, emojis: [], accountEmojis: [] });
  }

  // Build parallel queries
  const queries: Promise<void>[] = [];

  // 1. Media attachments (always)
  queries.push(
    db
      .prepare(
        `SELECT * FROM media_attachments WHERE status_id IN (${placeholders}) ORDER BY created_at ASC`,
      )
      .bind(...statusIds)
      .all()
      .then(({ results }) => {
        for (const row of results ?? []) {
          const entry = result.get(row.status_id as string);
          if (entry) {
            entry.mediaAttachments.push(
              serializeMediaAttachment(row as unknown as MediaAttachmentRow, domain),
            );
          }
        }
      }),
  );

  // 2. Emoji reactions (always)
  queries.push(
    db
      .prepare(
        `SELECT status_id, emoji, COUNT(*) as count FROM emoji_reactions WHERE status_id IN (${placeholders}) GROUP BY status_id, emoji`,
      )
      .bind(...statusIds)
      .all()
      .then(({ results }) => {
        for (const row of results ?? []) {
          const entry = result.get(row.status_id as string);
          if (entry) {
            entry.reactions.push({
              emoji: row.emoji as string,
              count: row.count as number,
            });
          }
        }
      }),
  );

  // 3. Mentions (always)
  queries.push(
    db
      .prepare(
        `SELECT m.status_id, m.account_id, a.username, a.domain, a.url AS a_url
         FROM mentions m
         JOIN accounts a ON a.id = m.account_id
         WHERE m.status_id IN (${placeholders})`,
      )
      .bind(...statusIds)
      .all()
      .then(({ results }) => {
        for (const row of results ?? []) {
          const entry = result.get(row.status_id as string);
          if (entry) {
            const username = row.username as string;
            const acctDomain = row.domain as string | null;
            entry.mentions.push({
              id: row.account_id as string,
              username,
              acct: acctDomain ? `${username}@${acctDomain}` : username,
              url: (row.a_url as string) || `https://${domain}/@${username}`,
            });
          }
        }
      }),
  );

  // 4. Preview cards (always)
  queries.push(
    db
      .prepare(
        `SELECT spc.status_id, pc.*
         FROM status_preview_cards spc
         JOIN preview_cards pc ON pc.id = spc.preview_card_id
         WHERE spc.status_id IN (${placeholders})`,
      )
      .bind(...statusIds)
      .all()
      .then(({ results }) => {
        for (const row of results ?? []) {
          const entry = result.get(row.status_id as string);
          if (entry && !entry.card) {
            entry.card = {
              url: row.url as string,
              title: (row.title as string) || '',
              description: (row.description as string) || '',
              type: (row.type as PreviewCard['type']) || 'link',
              author_name: (row.author_name as string) || '',
              author_url: (row.author_url as string) || '',
              provider_name: (row.provider_name as string) || '',
              provider_url: (row.provider_url as string) || '',
              html: (row.html as string) || '',
              width: (row.width as number) || 0,
              height: (row.height as number) || 0,
              image: (row.image_url as string) || null,
              embed_url: (row.embed_url as string) || '',
              blurhash: (row.blurhash as string) || null,
            };
          }
        }
      }),
  );

  // 5-7. Interaction states (only when authenticated)
  if (currentAccountId) {
    // Favourited
    queries.push(
      db
        .prepare(
          `SELECT status_id FROM favourites WHERE account_id = ?1 AND status_id IN (${placeholders})`,
        )
        .bind(currentAccountId, ...statusIds)
        .all()
        .then(({ results }) => {
          const favSet = new Set((results ?? []).map((r) => r.status_id as string));
          for (const id of statusIds) {
            const entry = result.get(id);
            if (entry) entry.favourited = favSet.has(id);
          }
        }),
    );

    // Reblogged
    queries.push(
      db
        .prepare(
          `SELECT reblog_of_id FROM statuses WHERE account_id = ?1 AND reblog_of_id IN (${placeholders}) AND deleted_at IS NULL`,
        )
        .bind(currentAccountId, ...statusIds)
        .all()
        .then(({ results }) => {
          const reblogSet = new Set((results ?? []).map((r) => r.reblog_of_id as string));
          for (const id of statusIds) {
            const entry = result.get(id);
            if (entry) entry.reblogged = reblogSet.has(id);
          }
        }),
    );

    // Bookmarked
    queries.push(
      db
        .prepare(
          `SELECT status_id FROM bookmarks WHERE account_id = ?1 AND status_id IN (${placeholders})`,
        )
        .bind(currentAccountId, ...statusIds)
        .all()
        .then(({ results }) => {
          const bmSet = new Set((results ?? []).map((r) => r.status_id as string));
          for (const id of statusIds) {
            const entry = result.get(id);
            if (entry) entry.bookmarked = bmSet.has(id);
          }
        }),
    );
  }

  // 8. Polls — auto-detect from statuses that have poll_id set
  if (!pollIdMap) {
    // Build pollIdMap by querying statuses for poll_ids
    const pollIdQuery = await db
      .prepare(`SELECT id, poll_id FROM statuses WHERE id IN (${placeholders}) AND poll_id IS NOT NULL`)
      .bind(...statusIds)
      .all<{ id: string; poll_id: string }>();
    if (pollIdQuery.results && pollIdQuery.results.length > 0) {
      pollIdMap = new Map();
      for (const row of pollIdQuery.results) {
        pollIdMap.set(row.id, row.poll_id);
      }
    }
  }

  if (pollIdMap && pollIdMap.size > 0) {
    const pollIds = [...new Set(pollIdMap.values())];
    const pollPlaceholders = pollIds.map(() => '?').join(',');

    // Fetch poll rows and user's votes in parallel
    const pollQueryPromise = db
      .prepare(`SELECT * FROM polls WHERE id IN (${pollPlaceholders})`)
      .bind(...pollIds)
      .all<PollRow>();

    const votesQueryPromise = currentAccountId
      ? db
          .prepare(
            `SELECT poll_id, choice FROM poll_votes WHERE poll_id IN (${pollPlaceholders}) AND account_id = ?${pollIds.length + 1}`,
          )
          .bind(...pollIds, currentAccountId)
          .all<{ poll_id: string; choice: number }>()
      : Promise.resolve({ results: [] as { poll_id: string; choice: number }[] });

    queries.push(
      Promise.all([pollQueryPromise, votesQueryPromise]).then(([pollResult, votesResult]) => {
        const pollRowMap = new Map<string, PollRow>();
        for (const row of pollResult.results ?? []) {
          pollRowMap.set(row.id, row);
        }

        const votesByPoll = new Map<string, number[]>();
        for (const v of votesResult.results ?? []) {
          if (!votesByPoll.has(v.poll_id)) votesByPoll.set(v.poll_id, []);
          votesByPoll.get(v.poll_id)!.push(v.choice);
        }

        for (const [statusId, pollId] of pollIdMap) {
          const pollRow = pollRowMap.get(pollId);
          const entry = result.get(statusId);
          if (pollRow && entry) {
            const ownVotes = votesByPoll.get(pollId) ?? [];
            entry.poll = serializePoll(pollRow, {
              voted: ownVotes.length > 0,
              ownVotes,
            });
          }
        }
      }),
    );
  }

  await Promise.all(queries);

  // 9. Custom emojis — extract from emoji_tags JSON, verify accessibility, proxy URLs
  const emojiTagsQuery = await db
    .prepare(
      `SELECT id, content, content_warning, emoji_tags FROM statuses WHERE id IN (${placeholders})`,
    )
    .bind(...statusIds)
    .all();

  const statusEmojiMap = new Map<string, EmojiInfo[]>();

  // Collect all unique emoji URLs across all statuses for batch verification
  const _allEmojiCandidates: Array<{ statusId: string; shortcode: string; url: string }> = [];

  for (const row of emojiTagsQuery.results ?? []) {
    const statusId = row.id as string;
    const content = (row.content as string) || '';
    const cw = (row.content_warning as string) || '';
    const text = content + ' ' + cw;

    const shortcodesInContent = new Set<string>();
    const emojiRegex = /:([a-zA-Z0-9_]+):/g;
    let match;
    while ((match = emojiRegex.exec(text)) !== null) {
      shortcodesInContent.add(match[1]);
    }

    let emojiTags: Array<Record<string, unknown>> = [];
    try {
      const tagsJson = row.emoji_tags as string | null;
      if (tagsJson) emojiTags = JSON.parse(tagsJson);
    } catch { /* skip */ }

    for (const tag of emojiTags) {
      const shortcode = (typeof tag.shortcode === 'string' ? tag.shortcode : ((tag.name as string) || '').replace(/^:|:$/g, ''));
      if (!shortcodesInContent.has(shortcode)) continue;
      const url = (tag.url as string) || (tag.icon as { url?: string } | undefined)?.url;
      if (!url) continue;

      const proxyUrl = proxyEmojiUrl(url, domain);
      if (!statusEmojiMap.has(statusId)) statusEmojiMap.set(statusId, []);
      statusEmojiMap.get(statusId)!.push({
        shortcode,
        url: proxyUrl,
        static_url: proxyUrl,
        visible_in_picker: false,
      });
    }
  }

  // Assign emojis to enrichment results
  for (const [statusId, emojis] of statusEmojiMap) {
    const entry = result.get(statusId);
    if (entry) {
      entry.emojis = emojis;
    }
  }

  // Note: Account emojis are NOT enriched. They are retrieved on-demand from 
  // account payloads when needed. No caching or pre-fetching.

  return result;
}
