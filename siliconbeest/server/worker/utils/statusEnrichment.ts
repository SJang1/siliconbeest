/**
 * Batch-fetch media attachments and interaction states for a list of statuses.
 * Used by all timeline endpoints to avoid N+1 queries.
 */

/* oxlint-disable fp/no-let, fp/no-loop-statements, fp/no-throw-statements, fp/no-try-statements, no-param-reassign */

import { env } from 'cloudflare:workers';
import type { MediaAttachment as MastodonMediaAttachment, PreviewCard, Poll as MastodonPoll, Status as MastodonStatus } from '../types/mastodon';
import { serializeAccount, serializeMediaAttachment, serializePoll, serializeStatus } from './mastodonSerializer';
import type { AccountRow, MediaAttachmentRow, PollRow, StatusRow } from '../types/db';
import { emojiTagToCustomEmoji } from '../../../../packages/shared/utils/customEmoji';
import { AS_PUBLIC } from '../../../../packages/shared/utils/quotePolicy';

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

function parseApprovalTargets(value: unknown): string[] | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return null;
  }
}

function hasPublicApproval(targets: string[]): boolean {
  return targets.includes(AS_PUBLIC) || targets.includes('as:Public') || targets.includes('Public');
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
  quote: MastodonStatus | null;
  emojis: EmojiInfo[];
  accountEmojis: EmojiInfo[];
  quotePolicyAllows: boolean;
  quotePolicyReason: string | null;
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
  quote: null,
  emojis: [],
  accountEmojis: [],
  quotePolicyAllows: true,
  quotePolicyReason: null,
};

/**
 * Batch-enrich statuses with media, emoji reactions, and interaction states.
 * Runs up to 5 queries in parallel (1 media + 1 reactions + 3 interactions if authenticated).
 */
export async function enrichStatuses(
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
    result.set(id, { ...EMPTY, mediaAttachments: [], reactions: [], mentions: [], card: null, poll: null, quote: null, emojis: [], accountEmojis: [], quotePolicyAllows: true, quotePolicyReason: null });
  }

  // Build parallel queries
  const queries: Promise<void>[] = [];

  queries.push(
    env.DB
      .prepare(
        `SELECT s.id, s.account_id, s.visibility, s.quote_policy,
                s.quote_policy_automatic_approvals, s.quote_policy_manual_approvals,
                a.uri AS account_uri
         FROM statuses s
         JOIN accounts a ON a.id = s.account_id
         WHERE s.id IN (${placeholders})`,
      )
      .bind(...statusIds)
      .all()
      .then(async ({ results }) => {
        const followerTargets = new Set<string>();
        const followingTargets = new Set<string>();
        const currentAccount = currentAccountId
          ? await env.DB.prepare('SELECT uri FROM accounts WHERE id = ?1 LIMIT 1')
            .bind(currentAccountId)
            .first<{ uri: string }>()
          : null;
        const currentAccountUri = currentAccount?.uri ?? null;
        for (const row of results ?? []) {
          const visibility = (row.visibility as string) || 'public';
          const policy = row.quote_policy === 'followers' || row.quote_policy === 'nobody' ? row.quote_policy as string : 'public';
          const entry = result.get(row.id as string);
          if (!entry) continue;

          if (currentAccountId && row.account_id === currentAccountId) {
            entry.quotePolicyAllows = visibility === 'public' || visibility === 'unlisted' || visibility === 'private';
            entry.quotePolicyReason = null;
          } else if (visibility !== 'public' && visibility !== 'unlisted') {
            entry.quotePolicyAllows = false;
            entry.quotePolicyReason = 'visibility';
          } else {
            const automaticApprovals = parseApprovalTargets(row.quote_policy_automatic_approvals);
            const manualApprovals = parseApprovalTargets(row.quote_policy_manual_approvals);
            const hasRawPolicy = automaticApprovals !== null || manualApprovals !== null;
            const approvals = [...(automaticApprovals ?? []), ...(manualApprovals ?? [])];
            if (hasRawPolicy) {
              const authorUri = row.account_uri as string;
              const followersUri = `${authorUri}/followers`;
              const followingUri = `${authorUri}/following`;
              if (hasPublicApproval(approvals) || (currentAccountUri && approvals.includes(currentAccountUri))) {
                entry.quotePolicyAllows = true;
                entry.quotePolicyReason = null;
              } else if (!currentAccountId) {
                entry.quotePolicyAllows = false;
                entry.quotePolicyReason = 'login_required';
              } else if (approvals.includes(followersUri)) {
                entry.quotePolicyAllows = false;
                entry.quotePolicyReason = 'followers_only';
                followerTargets.add(row.account_id as string);
              } else if (approvals.includes(followingUri)) {
                entry.quotePolicyAllows = false;
                entry.quotePolicyReason = 'following_only';
                followingTargets.add(row.account_id as string);
              } else {
                entry.quotePolicyAllows = false;
                entry.quotePolicyReason = 'policy_nobody';
              }
            } else if (policy === 'nobody') {
              entry.quotePolicyAllows = false;
              entry.quotePolicyReason = 'policy_nobody';
            } else if (policy === 'followers') {
              entry.quotePolicyAllows = false;
              entry.quotePolicyReason = currentAccountId ? 'followers_only' : 'login_required';
              if (currentAccountId) followerTargets.add(row.account_id as string);
            } else {
              entry.quotePolicyAllows = true;
              entry.quotePolicyReason = null;
            }
          }
        }

        if (!currentAccountId) return;
        if (followerTargets.size > 0) {
          const ids = [...followerTargets];
          const ph = ids.map(() => '?').join(',');
          const follows = await env.DB.prepare(
            `SELECT target_account_id FROM follows WHERE account_id = ?1 AND target_account_id IN (${ph})`,
          ).bind(currentAccountId, ...ids).all<{ target_account_id: string }>();
          const followed = new Set((follows.results ?? []).map((row) => row.target_account_id));
          for (const row of results ?? []) {
            const entry = result.get(row.id as string);
            if (!entry || entry.quotePolicyReason !== 'followers_only') continue;
            if (followed.has(row.account_id as string)) {
              entry.quotePolicyAllows = true;
              entry.quotePolicyReason = null;
            }
          }
        }
        if (followingTargets.size > 0) {
          const ids = [...followingTargets];
          const ph = ids.map(() => '?').join(',');
          const follows = await env.DB.prepare(
            `SELECT account_id FROM follows WHERE target_account_id = ?1 AND account_id IN (${ph})`,
          ).bind(currentAccountId, ...ids).all<{ account_id: string }>();
          const followedBy = new Set((follows.results ?? []).map((row) => row.account_id));
          for (const row of results ?? []) {
            const entry = result.get(row.id as string);
            if (!entry || entry.quotePolicyReason !== 'following_only') continue;
            if (followedBy.has(row.account_id as string)) {
              entry.quotePolicyAllows = true;
              entry.quotePolicyReason = null;
            }
          }
        }
      }),
  );

  // 1. Media attachments (always)
  queries.push(
    env.DB
      .prepare(
        `SELECT * FROM media_attachments WHERE status_id IN (${placeholders}) ORDER BY created_at ASC`,
      )
      .bind(...statusIds)
      .all<MediaAttachmentRow>()
      .then(({ results }) => {
        for (const row of results ?? []) {
          const entry = result.get(row.status_id as string);
          if (entry) {
            entry.mediaAttachments.push(
              serializeMediaAttachment(row, domain),
            );
          }
        }
      }),
  );

  // 2. Emoji reactions (always)
  queries.push(
    env.DB
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
    env.DB
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
    env.DB
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
      env.DB
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
      env.DB
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
      env.DB
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
    const pollIdQuery = await env.DB
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
    const pollQueryPromise = env.DB
      .prepare(`SELECT * FROM polls WHERE id IN (${pollPlaceholders})`)
      .bind(...pollIds)
      .all<PollRow>();

    const votesQueryPromise = currentAccountId
      ? env.DB
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

  queries.push(
    env.DB
      .prepare(
        `SELECT owner.id AS owner_status_id,
                qs.*,
                a.id AS account_id, a.username, a.domain, a.display_name, a.note, a.uri AS account_uri,
                a.url AS account_url, a.avatar_url, a.avatar_static_url, a.header_url, a.header_static_url,
                a.locked, a.bot, a.discoverable, a.manually_approves_followers,
                a.statuses_count, a.followers_count, a.following_count, a.last_status_at,
                a.created_at AS account_created_at, a.updated_at AS account_updated_at,
                a.suspended_at, a.silenced_at, a.memorial, a.moved_to_account_id, a.emoji_tags AS account_emoji_tags
         FROM statuses owner
         JOIN statuses qs ON qs.id = owner.quote_id AND qs.deleted_at IS NULL
         JOIN accounts a ON a.id = qs.account_id
         WHERE owner.id IN (${placeholders})`,
      )
      .bind(...statusIds)
      .all<Record<string, unknown>>()
      .then(({ results }) => {
        for (const row of results ?? []) {
          const entry = result.get(row.owner_status_id as string);
          if (!entry) continue;
          const accountRow: AccountRow = {
            id: row.account_id as string,
            username: row.username as string,
            domain: row.domain as string | null,
            display_name: (row.display_name as string) || '',
            note: (row.note as string) || '',
            uri: row.account_uri as string,
            url: (row.account_url as string) || null,
            avatar_url: (row.avatar_url as string) || '',
            avatar_static_url: (row.avatar_static_url as string) || '',
            header_url: (row.header_url as string) || '',
            header_static_url: (row.header_static_url as string) || '',
            locked: (row.locked as number) || 0,
            bot: (row.bot as number) || 0,
            discoverable: row.discoverable as number | null,
            manually_approves_followers: (row.manually_approves_followers as number) || 0,
            statuses_count: (row.statuses_count as number) || 0,
            followers_count: (row.followers_count as number) || 0,
            following_count: (row.following_count as number) || 0,
            last_status_at: row.last_status_at as string | null,
            created_at: row.account_created_at as string,
            updated_at: row.account_updated_at as string,
            suspended_at: row.suspended_at as string | null,
            silenced_at: row.silenced_at as string | null,
            memorial: (row.memorial as number) || 0,
            moved_to_account_id: row.moved_to_account_id as string | null,
            emoji_tags: row.account_emoji_tags as string | null,
          };
          entry.quote = serializeStatus(row as StatusRow, {
            account: serializeAccount(accountRow, { instanceDomain: domain }),
            mediaAttachments: [],
            mentions: [],
            tags: [],
            emojis: [],
            quote: null,
          });
        }
      }),
  );

  await Promise.all(queries);

  // 9. Custom emojis — extract from emoji_tags JSON, verify accessibility, proxy URLs
  const emojiTagsQuery = await env.DB
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
      const emoji = emojiTagToCustomEmoji(tag);
      if (!emoji || !shortcodesInContent.has(emoji.shortcode)) continue;

      const proxyUrl = proxyEmojiUrl(emoji.url, domain);
      if (!statusEmojiMap.has(statusId)) statusEmojiMap.set(statusId, []);
      statusEmojiMap.get(statusId)!.push({
        shortcode: emoji.shortcode,
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
