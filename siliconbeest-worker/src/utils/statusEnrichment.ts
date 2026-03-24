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
  accountEmojis: AccountEmojiInfo[];
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

  // 8. Custom emojis — fetch content from statuses and extract :shortcode: patterns
  // We need to fetch the status content to find shortcodes
  const contentQuery = await db
    .prepare(
      `SELECT id, content, content_warning FROM statuses WHERE id IN (${placeholders})`,
    )
    .bind(...statusIds)
    .all();

  const allShortcodes = new Set<string>();
  const statusShortcodes = new Map<string, string[]>();
  const emojiRegex = /:([a-zA-Z0-9_]+):/g;

  for (const row of contentQuery.results ?? []) {
    const id = row.id as string;
    const content = (row.content as string) || '';
    const cw = (row.content_warning as string) || '';
    const text = content + ' ' + cw;
    const codes: string[] = [];
    let match;
    while ((match = emojiRegex.exec(text)) !== null) {
      codes.push(match[1]);
      allShortcodes.add(match[1]);
    }
    if (codes.length > 0) {
      statusShortcodes.set(id, codes);
    }
  }

  if (allShortcodes.size > 0) {
    const shortcodeList = [...allShortcodes];
    const emojiPlaceholders = shortcodeList.map(() => '?').join(',');
    const { results: emojiRows } = await db
      .prepare(
        `SELECT shortcode, image_key, domain, visible_in_picker FROM custom_emojis WHERE shortcode IN (${emojiPlaceholders})`,
      )
      .bind(...shortcodeList)
      .all();

    // Build map: shortcode -> { domain -> EmojiInfo }
    // This allows domain-specific emoji matching
    const emojiByShortcodeDomain = new Map<string, Map<string, EmojiInfo>>();
    for (const er of emojiRows ?? []) {
      const sc = er.shortcode as string;
      const eDomain = (er.domain as string) || '__local__';
      const imageKey = er.image_key as string;
      const url = imageKey.startsWith('http') ? imageKey : `https://${domain}/media/${imageKey}`;
      if (!emojiByShortcodeDomain.has(sc)) emojiByShortcodeDomain.set(sc, new Map());
      emojiByShortcodeDomain.get(sc)!.set(eDomain, {
        shortcode: sc,
        url,
        static_url: url,
        visible_in_picker: !!(er.visible_in_picker),
      });
    }

    // Get account domains for each status to match emojis correctly
    const statusDomainMap = new Map<string, string>();
    if (statusIds.length > 0) {
      const domainPlaceholders = statusIds.map(() => '?').join(',');
      const { results: domainRows } = await db
        .prepare(`SELECT s.id, a.domain FROM statuses s JOIN accounts a ON a.id = s.account_id WHERE s.id IN (${domainPlaceholders})`)
        .bind(...statusIds)
        .all();
      for (const dr of domainRows ?? []) {
        statusDomainMap.set(dr.id as string, (dr.domain as string) || '__local__');
      }
    }

    for (const [statusId, codes] of statusShortcodes) {
      const entry = result.get(statusId);
      if (!entry) continue;
      const accountDomain = statusDomainMap.get(statusId) || '__local__';
      const seen = new Set<string>();
      for (const code of codes) {
        if (seen.has(code)) continue;
        seen.add(code);
        const domainMap = emojiByShortcodeDomain.get(code);
        if (!domainMap) continue;
        // Strict domain matching: same domain as account only
        const info = domainMap.get(accountDomain);
        if (info) {
          entry.emojis.push(info);
        }
      }
    }
  }

  // 9. Account emojis — fetch :shortcode: from display_name and note of each status's account
  // We need the account info (display_name, note, domain) per status
  if (statusIds.length > 0) {
    const acctInfoPlaceholders = statusIds.map(() => '?').join(',');
    const { results: acctInfoRows } = await db
      .prepare(
        `SELECT s.id AS status_id, a.display_name, a.note, a.domain
         FROM statuses s JOIN accounts a ON a.id = s.account_id
         WHERE s.id IN (${acctInfoPlaceholders})`,
      )
      .bind(...statusIds)
      .all();

    // Group statuses by account domain, collect all texts
    const acctTextsByDomain = new Map<string, string[]>();
    const statusAccountDomainMap = new Map<string, string>();
    for (const row of acctInfoRows ?? []) {
      const sid = row.status_id as string;
      const displayName = (row.display_name as string) || '';
      const note = (row.note as string) || '';
      const acctDomain = (row.domain as string) || null;
      const domainKey = acctDomain || '__local__';
      statusAccountDomainMap.set(sid, domainKey);
      if (!acctTextsByDomain.has(domainKey)) acctTextsByDomain.set(domainKey, []);
      acctTextsByDomain.get(domainKey)!.push(displayName, note);
    }

    // Batch-fetch account emojis per domain
    const acctEmojiMaps = new Map<string, Map<string, AccountEmojiInfo>>();
    const domainFetches: Promise<void>[] = [];
    for (const [domainKey, texts] of acctTextsByDomain) {
      domainFetches.push(
        fetchAccountEmojis(db, texts, domainKey === '__local__' ? null : domainKey).then((emojiMap) => {
          if (emojiMap.size > 0) acctEmojiMaps.set(domainKey, emojiMap);
        }),
      );
    }
    await Promise.all(domainFetches);

    // Assign account emojis to each status enrichment
    for (const row of acctInfoRows ?? []) {
      const sid = row.status_id as string;
      const displayName = (row.display_name as string) || '';
      const note = (row.note as string) || '';
      const domainKey = statusAccountDomainMap.get(sid) || '__local__';
      const emojiMap = acctEmojiMaps.get(domainKey);
      if (emojiMap && emojiMap.size > 0) {
        const entry = result.get(sid);
        if (entry) {
          entry.accountEmojis = getAccountEmojis(emojiMap, displayName, note);
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Account Emoji Enrichment
// ---------------------------------------------------------------------------

export type AccountEmojiInfo = {
  shortcode: string;
  url: string;
  static_url: string;
  visible_in_picker: boolean;
};

/**
 * Batch-fetch custom emojis for a set of account texts (display_name + note).
 * Domain-aware: only matches emojis from the specified account domain (or local).
 */
export async function fetchAccountEmojis(
  db: D1Database,
  texts: string[],
  accountDomain?: string | null,
): Promise<Map<string, AccountEmojiInfo>> {
  const result = new Map<string, AccountEmojiInfo>();
  const allShortcodes = new Set<string>();

  for (const text of texts) {
    if (!text) continue;
    const matches = text.matchAll(/:([a-zA-Z0-9_]{2,}?):/g);
    for (const m of matches) allShortcodes.add(m[1]);
  }

  if (allShortcodes.size === 0) return result;

  const codes = [...allShortcodes];
  const placeholders = codes.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT shortcode, image_key, domain FROM custom_emojis WHERE shortcode IN (${placeholders})`)
    .bind(...codes)
    .all();

  const targetDomain = accountDomain || null;
  // Group by shortcode, prefer same domain
  const byShortcode = new Map<string, Array<{ domain: string | null; url: string }>>();
  for (const r of results ?? []) {
    const sc = r.shortcode as string;
    const emojiDomain = (r.domain as string) || null;
    const imageKey = r.image_key as string;
    const url = imageKey.startsWith('http') ? imageKey : `https://${r.domain}/emoji/${imageKey}`;
    if (!byShortcode.has(sc)) byShortcode.set(sc, []);
    byShortcode.get(sc)!.push({ domain: emojiDomain, url });
  }
  for (const [sc, entries] of byShortcode) {
    // Strict domain matching only
    const match = entries.find(e => e.domain === targetDomain);
    if (match) {
      result.set(sc, { shortcode: sc, url: match.url, static_url: match.url, visible_in_picker: false });
    }
  }

  return result;
}

/**
 * Extract emojis from account's display_name and note, returning an array for serialization.
 */
export function getAccountEmojis(
  emojiMap: Map<string, AccountEmojiInfo>,
  displayName: string,
  note: string,
): AccountEmojiInfo[] {
  const found = new Map<string, AccountEmojiInfo>();
  const combined = `${displayName} ${note}`;
  const matches = combined.matchAll(/:([a-zA-Z0-9_]{2,}?):/g);
  for (const m of matches) {
    const emoji = emojiMap.get(m[1]);
    if (emoji) found.set(m[1], emoji);
  }
  return [...found.values()];
}
