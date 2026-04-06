/**
 * Emoji Fetching Utilities
 *
 * Pure functions for fetching custom emoji data from DB rows.
 * Emoji tags are stored as JSON arrays in the `emoji_tags` column
 * of both statuses and accounts tables.
 */

import type { CustomEmoji } from '../types/mastodon-base';

/**
 * Fetch emojis referenced in a status's content from its emoji_tags JSON column.
 * Only returns emojis whose shortcodes actually appear in the content or CW.
 * URLs are proxied through the instance's proxy endpoint.
 */
export async function fetchEmojisForStatus(
  db: D1Database,
  statusId: string,
  instanceDomain: string,
): Promise<CustomEmoji[]> {
  const row = await db
    .prepare('SELECT emoji_tags, content, content_warning FROM statuses WHERE id = ?')
    .bind(statusId)
    .first();
  if (!row) return [];

  const tagsJson = row.emoji_tags as string | null;
  if (!tagsJson) return [];

  let tags: Array<{ shortcode?: string; name?: string; url?: string; icon?: { url?: string } }> = [];
  try {
    tags = JSON.parse(tagsJson);
  } catch {
    return [];
  }

  // Extract shortcodes actually used in content
  const text = ((row.content as string) || '') + ' ' + ((row.content_warning as string) || '');
  const shortcodesInContent = new Set<string>();
  const regex = /:([a-zA-Z0-9_]+):/g;
  let m;
  while ((m = regex.exec(text)) !== null) shortcodesInContent.add(m[1]);

  return tags
    .map((t) => {
      const sc = t.shortcode || (t.name || '').replace(/^:|:$/g, '');
      const url = t.url || t.icon?.url || '';
      if (!sc || !url || !shortcodesInContent.has(sc)) return null;
      const proxied = url.startsWith('http')
        ? `https://${instanceDomain}/proxy?url=${encodeURIComponent(url)}`
        : url;
      return { shortcode: sc, url: proxied, static_url: proxied, visible_in_picker: false };
    })
    .filter(Boolean) as CustomEmoji[];
}

/**
 * Fetch emojis from an account's emoji_tags JSON column.
 * URLs are proxied through the instance's proxy endpoint.
 */
export async function fetchAccountEmojis(
  db: D1Database,
  accountId: string,
  instanceDomain: string,
): Promise<CustomEmoji[]> {
  const row = await db
    .prepare('SELECT emoji_tags FROM accounts WHERE id = ?')
    .bind(accountId)
    .first();
  if (!row) return [];

  const tagsJson = row.emoji_tags as string | null;
  if (!tagsJson) return [];

  let tags: Array<{ shortcode?: string; name?: string; url?: string; static_url?: string }> = [];
  try {
    tags = JSON.parse(tagsJson);
  } catch {
    return [];
  }

  return tags
    .map((t) => {
      const sc = t.shortcode || (t.name || '').replace(/^:|:$/g, '');
      const url = t.url || '';
      const staticUrl = t.static_url || url;
      const proxied = url.startsWith('http')
        ? `https://${instanceDomain}/proxy?url=${encodeURIComponent(url)}`
        : url;
      const proxiedStatic = staticUrl.startsWith('http')
        ? `https://${instanceDomain}/proxy?url=${encodeURIComponent(staticUrl)}`
        : staticUrl;
      return { shortcode: sc, url: proxied, static_url: proxiedStatic, visible_in_picker: false };
    })
    .filter((e) => e.shortcode && e.url);
}
