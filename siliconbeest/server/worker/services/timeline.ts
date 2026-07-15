import { env } from 'cloudflare:workers';
import { parsePaginationParams, buildPaginationQuery } from '../utils/pagination';
import type { PaginationParams } from '../utils/pagination';
import { AppError } from '../middleware/errorHandler';
import {
  buildReblogOriginalSurfaceSqlPredicate,
  buildStatusRelationshipSqlPredicate,
  buildStatusVisibilitySqlPredicate,
} from './permissions';
import type {
  PermissionSqlPredicate,
  StatusPermissionSqlSource,
} from './permissions';

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

type StatusTimelineCursor = {
  id: string;
  created_at: string;
};

// ----------------------------------------------------------------
// Relationship/account-state surface filter helper
// ----------------------------------------------------------------

function addStatusSurfaceFilters(
  conditions: string[],
  binds: (string | number)[],
  viewerAccountId: string | undefined,
  statusSource: StatusPermissionSqlSource = 'status',
): void {
  const now = new Date().toISOString();
  const relationship = buildStatusRelationshipSqlPredicate(
    statusSource,
    viewerAccountId ?? null,
    now,
  );
  conditions.push(relationship.sql);
  binds.push(...relationship.bindings);
  if (statusSource === 'status') {
    const reblogOriginal = buildReblogOriginalSurfaceSqlPredicate(
      viewerAccountId ?? null,
      now,
    );
    conditions.push(reblogOriginal.sql);
    binds.push(...reblogOriginal.bindings);
  }
}

function buildHomeTimelineMembershipPredicate(
  accountId: string,
): PermissionSqlPredicate {
  return {
    sql: `(
      s.account_id = ?
      OR EXISTS (
        SELECT 1
        FROM follows home_follow
        WHERE home_follow.account_id = ?
          AND home_follow.target_account_id = s.account_id
          AND s.visibility != 'direct'
          AND (s.reblog_of_id IS NULL OR COALESCE(home_follow.show_reblogs, 1) != 0)
      )
      OR (
        s.visibility = 'direct'
        AND EXISTS (
          SELECT 1
          FROM mentions home_mention
          WHERE home_mention.status_id = s.id
            AND home_mention.account_id = ?
        )
      )
    )`,
    bindings: [accountId, accountId, accountId],
  };
}

async function addChronologicalCursorFilters(
  pag: PaginationParams,
  conditions: string[],
  binds: (string | number)[],
): Promise<boolean> {
  const requestedIds = [...new Set([
    pag.maxId,
    pag.sinceId,
    pag.minId,
  ].filter((id): id is string => id !== undefined))];

  const cursorEntries = await Promise.all(requestedIds.map(async (id) => {
    const cursor = await env.DB.prepare(
      'SELECT id, created_at FROM statuses WHERE id = ?1 LIMIT 1',
    ).bind(id).first<StatusTimelineCursor>();
    return [id, cursor] as const;
  }));
  const cursors = new Map(cursorEntries);

  function addCursor(id: string | undefined, direction: 'before' | 'after'): boolean {
    if (!id) return true;
    const cursor = cursors.get(id);
    if (!cursor) return false;
    const comparison = direction === 'before' ? '<' : '>';
    conditions.push(
      `(s.created_at ${comparison} ? OR (s.created_at = ? AND s.id ${comparison} ?))`,
    );
    binds.push(cursor.created_at, cursor.created_at, cursor.id);
    return true;
  }

  return addCursor(pag.maxId, 'before')
    && addCursor(pag.sinceId, 'after')
    && addCursor(pag.minId, 'after');
}

// ----------------------------------------------------------------
// Home timeline
// ----------------------------------------------------------------

/**
 * Fetch the home timeline for the given account.
 *
 * Derives membership from the viewer's follows and direct mentions instead of
 * storing one timeline row per recipient. Ordering and pagination use the
 * status timestamp plus ID as a stable tie-breaker.
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

  const membership = buildHomeTimelineMembershipPredicate(accountId);
  const conditions: string[] = [membership.sql];
  const binds: (string | number)[] = [...membership.bindings];
  const orderDirection = pag.minId ? 'ASC' : 'DESC';

  if (!await addChronologicalCursorFilters(pag, conditions, binds)) return [];

  conditions.push('s.deleted_at IS NULL');
  const visibility = buildStatusVisibilitySqlPredicate('status', accountId);
  conditions.push(visibility.sql);
  binds.push(...visibility.bindings);
  addStatusSurfaceFilters(conditions, binds, accountId);

  const sql = `
    SELECT s.*, ${ACCOUNT_COLUMNS}
    FROM statuses s
    JOIN accounts a ON a.id = s.account_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY s.created_at ${orderDirection}, s.id ${orderDirection}
    LIMIT ?
  `;
  binds.push(pag.limit);

  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return (results ?? []) as Record<string, unknown>[];
}

// ----------------------------------------------------------------
// Social timeline (home ∪ local)
// ----------------------------------------------------------------

/**
 * Fetch the merged "social" timeline: everything derived for the viewer's
 * home timeline plus every local public status.
 */
export async function getSocialTimeline(
  accountId: string,
  opts: TimelinePaginationOpts,
): Promise<Record<string, unknown>[]> {
  const pag = parsePaginationParams({
    max_id: opts.maxId,
    since_id: opts.sinceId,
    min_id: opts.minId,
    limit: opts.limit != null ? String(opts.limit) : undefined,
  });

  const membership = buildHomeTimelineMembershipPredicate(accountId);
  const orderDirection = pag.minId ? 'ASC' : 'DESC';

  const conditions: string[] = [
    `(
      ${membership.sql}
      OR (s.local = 1 AND s.visibility = 'public')
    )`,
    's.deleted_at IS NULL',
  ];
  const binds: (string | number)[] = [...membership.bindings];

  if (!await addChronologicalCursorFilters(pag, conditions, binds)) return [];
  const visibility = buildStatusVisibilitySqlPredicate('status', accountId);
  conditions.push(visibility.sql);
  binds.push(...visibility.bindings);
  addStatusSurfaceFilters(conditions, binds, accountId);

  const sql = `
    SELECT s.*, ${ACCOUNT_COLUMNS}
    FROM statuses s
    JOIN accounts a ON a.id = s.account_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY s.created_at ${orderDirection}, s.id ${orderDirection}
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
  addStatusSurfaceFilters(conditions, binds, opts.viewerAccountId);

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
  addStatusSurfaceFilters(conditions, binds, opts.viewerAccountId);

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
  const visibility = buildStatusVisibilitySqlPredicate('status', accountId);
  conditions.push(visibility.sql);
  binds.push(...visibility.bindings);
  addStatusSurfaceFilters(conditions, binds, accountId);

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
