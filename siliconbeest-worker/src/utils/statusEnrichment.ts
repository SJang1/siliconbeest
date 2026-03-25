/**
 * Batch-fetch media attachments and interaction states for a list of statuses.
 * Used by all timeline endpoints to avoid N+1 queries.
 */

import type { MediaAttachment as MastodonMediaAttachment, PreviewCard } from '../types/mastodon';
import { serializeMediaAttachment } from './mastodonSerializer';
import type { MediaAttachmentRow } from '../types/db';

export interface MentionInfo {
  id: string;
  username: string;
  acct: string;
  url: string;
}

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

export interface EmojiInfo {
  shortcode: string;
  url: string;
  static_url: string;
  visible_in_picker: boolean;
}

export interface StatusEnrichment {
  mediaAttachments: MastodonMediaAttachment[];
  favourited: boolean | null;
  reblogged: boolean | null;
  bookmarked: boolean | null;
  reactions: { emoji: string; count: number }[];
  mentions: MentionInfo[];
  card: PreviewCard | null;
  emojis: EmojiInfo[];
  accountEmojis: EmojiInfo[];
}

const EMPTY: StatusEnrichment = {
  mediaAttachments: [],
  favourited: null,
  reblogged: null,
  bookmarked: null,
  reactions: [],
  mentions: [],
  card: null,
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
): Promise<Map<string, StatusEnrichment>> {
  if (statusIds.length === 0) return new Map();

  const placeholders = statusIds.map(() => '?').join(',');
  const result = new Map<string, StatusEnrichment>();

  // Initialize all entries
  for (const id of statusIds) {
    result.set(id, { ...EMPTY, mediaAttachments: [], reactions: [], mentions: [], card: null, emojis: [], accountEmojis: [] });
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

  await Promise.all(queries);

  // 8. Custom emojis — extract from status emoji_tags (lazy-load, no caching)
  // Fetch emoji_tags JSON from statuses table
  const emojiTagsQuery = await db
    .prepare(
      `SELECT id, content, content_warning, emoji_tags FROM statuses WHERE id IN (${placeholders})`,
    )
    .bind(...statusIds)
    .all();

  const statusEmojiMap = new Map<string, EmojiInfo[]>();

  for (const row of emojiTagsQuery.results ?? []) {
    const statusId = row.id as string;
    const content = (row.content as string) || '';
    const cw = (row.content_warning as string) || '';
    const text = content + ' ' + cw;

    // Extract shortcodes found in content
    const shortcodesInContent = new Set<string>();
    const emojiRegex = /:([a-zA-Z0-9_]+):/g;
    let match;
    while ((match = emojiRegex.exec(text)) !== null) {
      shortcodesInContent.add(match[1]);
    }

    // Parse emoji_tags array from JSON
    let emojiTags: Array<Record<string, unknown>> = [];
    try {
      const tagsJson = row.emoji_tags as string | null;
      if (tagsJson) {
        emojiTags = JSON.parse(tagsJson);
      }
    } catch { /* invalid JSON, skip */ }

    // Match emojis: filter emojiTags to only those referenced in content
    const emojis: EmojiInfo[] = [];
    for (const tag of emojiTags) {
      const tagName = (tag.name as string || '').replace(/^:|:$/g, '');
      if (!shortcodesInContent.has(tagName)) continue;

      const iconObj = tag.icon as Record<string, unknown> | undefined;
      const iconUrl = iconObj?.url as string | undefined;
      if (!iconUrl) continue;

      // Proxy remote emoji URLs through /proxy endpoint
      let proxyUrl = proxyEmojiUrl(iconUrl, domain);

      emojis.push({
        shortcode: tagName,
        url: proxyUrl,
        static_url: proxyUrl,
        visible_in_picker: false,
      });
    }

    if (emojis.length > 0) {
      statusEmojiMap.set(statusId, emojis);
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
