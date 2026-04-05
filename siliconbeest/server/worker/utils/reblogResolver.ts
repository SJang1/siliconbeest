type D1Database = import('../env').Env['DB'];
import { enrichStatuses } from './statusEnrichment';

/**
 * Given a list of status rows that may include reblogs (reblog_of_id != null),
 * fetches the original statuses and their enrichments, returns a map of
 * reblog_of_id -> serialized original status object.
 */
export async function resolveReblogs(
  db: D1Database,
  domain: string,
  rows: Record<string, unknown>[],
  currentAccountId: string | null,
  serializeStatusFn: (row: Record<string, unknown>, domain: string) => any,
): Promise<Map<string, any>> {
  const reblogOfIds = rows
    .map((r) => r.reblog_of_id as string | null)
    .filter((id): id is string => !!id);

  if (reblogOfIds.length === 0) return new Map();

  const unique = [...new Set(reblogOfIds)];
  const placeholders = unique.map(() => '?').join(',');

  const { results } = await db.prepare(
    `SELECT s.*,
      a.username AS account_username, a.domain AS account_domain,
      a.display_name AS account_display_name, a.note AS account_note,
      a.uri AS account_uri, a.url AS account_url,
      a.avatar_url AS account_avatar_url, a.avatar_static_url AS account_avatar_static_url,
      a.header_url AS account_header_url, a.header_static_url AS account_header_static_url,
      a.locked AS account_locked, a.bot AS account_bot, a.discoverable AS account_discoverable,
      a.followers_count AS account_followers_count, a.following_count AS account_following_count,
      a.statuses_count AS account_statuses_count, a.last_status_at AS account_last_status_at,
      a.created_at AS account_created_at
    FROM statuses s
    JOIN accounts a ON a.id = s.account_id
    WHERE s.id IN (${placeholders}) AND s.deleted_at IS NULL`,
  ).bind(...unique).all();

  const enrichments = await enrichStatuses(db, domain, unique, currentAccountId);
  const map = new Map<string, any>();

  for (const r of (results ?? []) as Record<string, unknown>[]) {
    const s = serializeStatusFn(r, domain);
    const e = enrichments.get(r.id as string);
    if (e) {
      s.media_attachments = e.mediaAttachments;
      s.favourited = e.favourited ?? false;
      s.reblogged = e.reblogged ?? false;
      s.bookmarked = e.bookmarked ?? false;
      s.card = e.card ?? null;
      s.emojis = e.emojis ?? [];
    }
    map.set(r.id as string, s);
  }

  return map;
}
