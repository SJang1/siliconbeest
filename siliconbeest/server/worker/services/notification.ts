import { env } from 'cloudflare:workers';
import { generateUlid } from '../utils/ulid';
import { AppError } from '../middleware/errorHandler';
import type { NotificationRow } from '../types/db';

// -----------------------------------------------------------------
// Shared types
// -----------------------------------------------------------------

/** A notification row joined with the from-account columns. */
export interface NotifWithAccountRow {
  id: string;
  account_id: string;
  from_account_id: string;
  type: string;
  status_id: string | null;
  emoji: string | null;
  read: number;
  created_at: string;
  a_id: string;
  a_username: string;
  a_domain: string | null;
  a_display_name: string;
  a_note: string;
  a_uri: string;
  a_url: string | null;
  a_avatar_url: string | null;
  a_avatar_static_url: string | null;
  a_header_url: string | null;
  a_header_static_url: string | null;
  a_locked: number;
  a_bot: number;
  a_discoverable: number | null;
  a_statuses_count: number;
  a_followers_count: number;
  a_following_count: number;
  a_last_status_at: string | null;
  a_created_at: string;
  a_suspended_at: string | null;
  a_memorial: number;
  a_moved_to_account_id: string | null;
  a_emoji_tags: string | null;
}

/** The account-joined SELECT fragment reused across queries. */
const ACCOUNT_JOIN_COLUMNS = `
  n.*, a.id AS a_id, a.username AS a_username, a.domain AS a_domain,
  a.display_name AS a_display_name, a.note AS a_note, a.uri AS a_uri,
  a.url AS a_url, a.avatar_url AS a_avatar_url, a.avatar_static_url AS a_avatar_static_url,
  a.header_url AS a_header_url, a.header_static_url AS a_header_static_url,
  a.locked AS a_locked, a.bot AS a_bot, a.discoverable AS a_discoverable,
  a.statuses_count AS a_statuses_count, a.followers_count AS a_followers_count,
  a.following_count AS a_following_count, a.last_status_at AS a_last_status_at,
  a.created_at AS a_created_at, a.suspended_at AS a_suspended_at,
  a.memorial AS a_memorial, a.moved_to_account_id AS a_moved_to_account_id,
  a.emoji_tags AS a_emoji_tags
`;

// -----------------------------------------------------------------
// listNotifications
// -----------------------------------------------------------------

export interface ListNotificationsOpts {
  /** SQL WHERE clause for pagination (e.g. "n.id < ?"). */
  whereClause?: string;
  /** SQL ORDER BY expression (e.g. "n.id DESC"). */
  orderClause?: string;
  /** Bound params for the whereClause placeholders. */
  paginationParams?: string[];
  /** Page size. */
  limit: number;
  /** Type include filter. */
  types?: string[];
  /** Type exclude filter. */
  excludeTypes?: string[];
}

export async function listNotifications(
  accountId: string,
  opts: ListNotificationsOpts,
): Promise<NotifWithAccountRow[]> {
  const conditions: string[] = ['n.account_id = ?'];
  const binds: (string | number)[] = [accountId];

  if (opts.whereClause) {
    conditions.push(opts.whereClause);
    binds.push(...(opts.paginationParams ?? []));
  }

  if (opts.types && opts.types.length > 0) {
    const placeholders = opts.types.map(() => '?').join(', ');
    conditions.push(`n.type IN (${placeholders})`);
    binds.push(...opts.types);
  }

  if (opts.excludeTypes && opts.excludeTypes.length > 0) {
    const placeholders = opts.excludeTypes.map(() => '?').join(', ');
    conditions.push(`n.type NOT IN (${placeholders})`);
    binds.push(...opts.excludeTypes);
  }

  const orderClause = opts.orderClause ?? 'n.id DESC';
  binds.push(opts.limit);

  const sql = `
    SELECT ${ACCOUNT_JOIN_COLUMNS}
    FROM notifications n
    JOIN accounts a ON a.id = n.from_account_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderClause}
    LIMIT ?
  `;

  const { results } = await env.DB.prepare(sql).bind(...binds).all<NotifWithAccountRow>();
  return results ?? [];
}

// -----------------------------------------------------------------
// getNotification
// -----------------------------------------------------------------

export async function getNotification(
  id: string,
  accountId: string,
): Promise<NotifWithAccountRow | null> {
  const sql = `
    SELECT ${ACCOUNT_JOIN_COLUMNS}
    FROM notifications n
    JOIN accounts a ON a.id = n.from_account_id
    WHERE n.id = ?1 AND n.account_id = ?2
    LIMIT 1
  `;
  return env.DB.prepare(sql).bind(id, accountId).first<NotifWithAccountRow>();
}

// -----------------------------------------------------------------
// dismissNotification
// -----------------------------------------------------------------

/**
 * Delete a single notification. Throws 404 if it does not exist.
 */
export async function dismissNotification(
  id: string,
  accountId: string,
): Promise<void> {
  const result = await env.DB
    .prepare('DELETE FROM notifications WHERE id = ?1 AND account_id = ?2')
    .bind(id, accountId)
    .run();

  if (!result.meta.changes || result.meta.changes === 0) {
    throw new AppError(404, 'Record not found');
  }
}

// -----------------------------------------------------------------
// clearAllNotifications
// -----------------------------------------------------------------

export async function clearAllNotifications(
  accountId: string,
): Promise<void> {
  await env.DB
    .prepare('DELETE FROM notifications WHERE account_id = ?1')
    .bind(accountId)
    .run();
}

// -----------------------------------------------------------------
// createNotification
// -----------------------------------------------------------------

export async function createNotification(
  accountId: string,
  fromAccountId: string,
  type: string,
  statusId?: string,
  emoji?: string,
): Promise<NotificationRow> {
  // Don't notify yourself
  if (accountId === fromAccountId) {
    throw new AppError(422, 'Cannot create notification for yourself');
  }

  // Check for duplicate: same type, from same account, for same status
  const existing = await env.DB
    .prepare(
      `SELECT id FROM notifications
       WHERE account_id = ? AND from_account_id = ? AND type = ?
       AND (status_id = ? OR (status_id IS NULL AND ? IS NULL))
       LIMIT 1`,
    )
    .bind(accountId, fromAccountId, type, statusId ?? null, statusId ?? null)
    .first();

  if (existing) {
    const row = await env.DB
      .prepare('SELECT * FROM notifications WHERE id = ? AND account_id = ? LIMIT 1')
      .bind(existing.id as string, accountId)
      .first<NotificationRow>();
    if (row) return row;
  }

  // Check if target has muted the source
  const muted = await env.DB
    .prepare(
      'SELECT hide_notifications FROM mutes WHERE account_id = ? AND target_account_id = ? LIMIT 1',
    )
    .bind(accountId, fromAccountId)
    .first();

  if (muted && muted.hide_notifications) {
    throw new AppError(422, 'Notifications muted');
  }

  // Check if target has blocked the source
  const blocked = await env.DB
    .prepare(
      'SELECT id FROM blocks WHERE account_id = ? AND target_account_id = ? LIMIT 1',
    )
    .bind(accountId, fromAccountId)
    .first();

  if (blocked) {
    throw new AppError(422, 'Account blocked');
  }

  const id = generateUlid();
  const now = new Date().toISOString();

  await env.DB
    .prepare(
      `INSERT INTO notifications (id, account_id, from_account_id, type, status_id, emoji, read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .bind(id, accountId, fromAccountId, type, statusId ?? null, emoji ?? null, now)
    .run();

  return (await env.DB
    .prepare('SELECT * FROM notifications WHERE id = ? AND account_id = ? LIMIT 1')
    .bind(id, accountId)
    .first<NotificationRow>())!;
}
