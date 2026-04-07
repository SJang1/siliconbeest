import { env } from 'cloudflare:workers';
import { parsePaginationParams, buildPaginationQuery } from '../utils/pagination';
import type { PaginationParams } from '../utils/pagination';
import { AppError } from '../middleware/errorHandler';

/**
 * Shared account columns selected alongside statuses in timeline queries.
 * Every timeline function uses this exact column list for the JOIN on accounts.
 */
const ACCOUNT_COLUMNS = `
  a.id AS a_id, a.username AS a_username, a.domain AS a_domain,
  a.display_name AS a_display_name, a.note AS a_note, a.uri AS a_uri,
  a.url AS a_url, a.avatar_url AS a_avatar_url, a.avatar_static_url AS a_avatar_static_url,
  a.header_url AS a_header_url, a.header_static_url AS a_header_static_url,
  a.locked AS a_locked, a.bot AS a_bot, a.discoverable AS a_discoverable,
  a.statuses_count AS a_statuses_count, a.followers_count AS a_followers_count,
  a.following_count AS a_following_count, a.last_status_at AS a_last_status_at,
  a.created_at AS a_created_at, a.suspended_at AS a_suspended_at,
  a.memorial AS a_memorial, a.moved_to_account_id AS a_moved_to_account_id,
  a.emoji_tags AS a_emoji_tags`;

export interface TimelinePaginationOpts {
  maxId?: string;
  sinceId?: string;
  minId?: string;
  limit?: number;
}

export interface PublicTimelineOpts extends TimelinePaginationOpts {
  local?: boolean;
  remote?: boolean;
  onlyMedia?: boolean;
  viewerAccountId?: string;
}

export interface TagTimelineOpts extends TimelinePaginationOpts {
  local?: boolean;
  onlyMedia?: boolean;
  viewerAccountId?: string;
}

// ----------------------------------------------------------------
// Block/Mute filter helper
// ----------------------------------------------------------------

function addBlockMuteFilters(
  conditions: string[],
  binds: (string | number)[],
  viewerAccountId: string | undefined,
  statusAlias = 's',
): void {
  if (!viewerAccountId) return;
  conditions.push(
    `${statusAlias}.account_id NOT IN (SELECT target_account_id FROM blocks WHERE account_id = ?)`,
  );
  binds.push(viewerAccountId);
  conditions.push(
    `${statusAlias}.account_id NOT IN (SELECT target_account_id FROM mutes WHERE account_id = ? AND (expires_at IS NULL OR expires_at > ?))`,
  );
  binds.push(viewerAccountId, new Date().toISOString());
}

// ----------------------------------------------------------------
// Home timeline
// ----------------------------------------------------------------

/**
 * Fetch the home timeline for the given account.
 *
 * Uses `hte.rowid` for ordering — it auto-increments on INSERT and correctly
 * reflects the order statuses entered the home timeline, regardless of whether
 * the status ID is local (00MN) or remote (01KM). Cursor pagination resolves
 * the status ID to its rowid via subquery.
 */
export async function getHomeTimeline(
  accountId: string,
  opts: TimelinePaginationOpts,
): Promise<Record<string, unknown>[]> {
  const pag = parsePaginationParams({
    max_id: opts.maxId,
    since_id: opts.sinceId,
    min_id: opts.minId,
    limit: opts.limit != null ? String(opts.limit) : undefined,
  });

  const conditions: string[] = ['hte.account_id = ?'];
  const binds: (string | number)[] = [accountId];
  let orderClause = 'hte.rowid DESC';

  if (pag.maxId) {
    conditions.push(
      'hte.rowid < (SELECT rowid FROM home_timeline_entries WHERE account_id = ? AND status_id = ?)',
    );
    binds.push(accountId, pag.maxId);
  }
  if (pag.sinceId) {
    conditions.push(
      'hte.rowid > (SELECT rowid FROM home_timeline_entries WHERE account_id = ? AND status_id = ?)',
    );
    binds.push(accountId, pag.sinceId);
  }
  if (pag.minId) {
    conditions.push(
      'hte.rowid > (SELECT rowid FROM home_timeline_entries WHERE account_id = ? AND status_id = ?)',
    );
    binds.push(accountId, pag.minId);
    orderClause = 'hte.rowid ASC';
  }

  conditions.push('s.deleted_at IS NULL');
  addBlockMuteFilters(conditions, binds, accountId);

  const sql = `
    SELECT s.*, ${ACCOUNT_COLUMNS}
    FROM home_timeline_entries hte
    JOIN statuses s ON s.id = hte.status_id
    JOIN accounts a ON a.id = s.account_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderClause}
    LIMIT ?
  `;
  binds.push(pag.limit);

  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return (results ?? []) as Record<string, unknown>[];
}

// ----------------------------------------------------------------
// Public timeline
// ----------------------------------------------------------------

export async function getPublicTimeline(
  opts: PublicTimelineOpts,
): Promise<Record<string, unknown>[]> {
  const pag = parsePaginationParams({
    max_id: opts.maxId,
    since_id: opts.sinceId,
    min_id: opts.minId,
    limit: opts.limit != null ? String(opts.limit) : undefined,
  });

  const { whereClause, limitValue, params } = buildPaginationQuery(pag, 's.id');
  const orderClause = pag.minId ? 's.created_at ASC' : 's.created_at DESC';

  const conditions: string[] = [`s.visibility = 'public'`, 's.deleted_at IS NULL'];
  const binds: (string | number)[] = [];

  if (whereClause) {
    conditions.push(whereClause);
    binds.push(...params);
  }

  if (opts.local) {
    conditions.push('s.local = 1');
  }
  if (opts.remote) {
    conditions.push('s.local = 0');
  }
  if (opts.onlyMedia) {
    conditions.push('EXISTS (SELECT 1 FROM media_attachments ma WHERE ma.status_id = s.id)');
  }
  addBlockMuteFilters(conditions, binds, opts.viewerAccountId);

  const sql = `
    SELECT s.*, ${ACCOUNT_COLUMNS}
    FROM statuses s
    JOIN accounts a ON a.id = s.account_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderClause}
    LIMIT ?
  `;
  binds.push(limitValue);

  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return (results ?? []) as Record<string, unknown>[];
}

// ----------------------------------------------------------------
// Tag timeline
// ----------------------------------------------------------------

export async function getTagTimeline(
  tag: string,
  opts: TagTimelineOpts,
): Promise<Record<string, unknown>[]> {
  const tagName = tag.toLowerCase();

  const pag = parsePaginationParams({
    max_id: opts.maxId,
    since_id: opts.sinceId,
    min_id: opts.minId,
    limit: opts.limit != null ? String(opts.limit) : undefined,
  });

  const { whereClause, limitValue, params } = buildPaginationQuery(pag, 's.id');
  const orderClause = pag.minId ? 's.created_at ASC' : 's.created_at DESC';

  const conditions: string[] = ['t.name = ?', `s.visibility = 'public'`, 's.deleted_at IS NULL'];
  const binds: (string | number)[] = [tagName];

  if (whereClause) {
    conditions.push(whereClause);
    binds.push(...params);
  }

  if (opts.local) {
    conditions.push('s.local = 1');
  }
  if (opts.onlyMedia) {
    conditions.push('EXISTS (SELECT 1 FROM media_attachments ma WHERE ma.status_id = s.id)');
  }
  addBlockMuteFilters(conditions, binds, opts.viewerAccountId);

  const sql = `
    SELECT s.*, ${ACCOUNT_COLUMNS}
    FROM status_tags st
    JOIN tags t ON t.id = st.tag_id
    JOIN statuses s ON s.id = st.status_id
    JOIN accounts a ON a.id = s.account_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderClause}
    LIMIT ?
  `;
  binds.push(limitValue);

  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return (results ?? []) as Record<string, unknown>[];
}

// ----------------------------------------------------------------
// List timeline
// ----------------------------------------------------------------

export async function getListTimeline(
  listId: string,
  accountId: string,
  opts: TimelinePaginationOpts,
): Promise<Record<string, unknown>[]> {
  // Verify list ownership
  const list = await env.DB
    .prepare('SELECT id FROM lists WHERE id = ?1 AND account_id = ?2')
    .bind(listId, accountId)
    .first();

  if (!list) {
    throw new AppError(404, 'Record not found');
  }

  const pag = parsePaginationParams({
    max_id: opts.maxId,
    since_id: opts.sinceId,
    min_id: opts.minId,
    limit: opts.limit != null ? String(opts.limit) : undefined,
  });

  const { whereClause, limitValue, params } = buildPaginationQuery(pag, 's.id');
  const orderClause = pag.minId ? 's.created_at ASC' : 's.created_at DESC';

  const conditions: string[] = ['la.list_id = ?', 's.deleted_at IS NULL'];
  const binds: (string | number)[] = [listId];

  if (whereClause) {
    conditions.push(whereClause);
    binds.push(...params);
  }
  addBlockMuteFilters(conditions, binds, accountId);

  const sql = `
    SELECT s.*, ${ACCOUNT_COLUMNS}
    FROM statuses s
    JOIN accounts a ON a.id = s.account_id
    JOIN list_accounts la ON la.account_id = s.account_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderClause}
    LIMIT ?
  `;
  binds.push(limitValue);

  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return (results ?? []) as Record<string, unknown>[];
}
