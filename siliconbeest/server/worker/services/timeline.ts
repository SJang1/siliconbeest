import { env } from 'cloudflare:workers';
import { parsePaginationParams, buildPaginationQuery } from '../utils/pagination';
import type { PaginationParams } from '../utils/pagination';
import { AppError } from '../middleware/errorHandler';
import type { TimelineStatusRow } from '../types/db';
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

const RECOMMENDATION_ID_QUERY_BATCH_SIZE = 60;
const RECOMMENDATION_SOURCE_SCAN_MULTIPLIER = 4;
const RECOMMENDATION_SOURCE_SCAN_LIMIT = 800;

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
  originalsOnly?: boolean;
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
): Promise<TimelineStatusRow[]> {
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

  const { results } = await env.DB.prepare(sql).bind(...binds).all<TimelineStatusRow>();
  return results ?? [];
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
): Promise<TimelineStatusRow[]> {
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

  const { results } = await env.DB.prepare(sql).bind(...binds).all<TimelineStatusRow>();
  return results ?? [];
}

// ----------------------------------------------------------------
// Public timeline
// ----------------------------------------------------------------

export async function getPublicTimeline(
  opts: PublicTimelineOpts,
): Promise<TimelineStatusRow[]> {
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
  if (opts.originalsOnly) {
    conditions.push('s.reblog_of_id IS NULL');
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

  const { results } = await env.DB.prepare(sql).bind(...binds).all<TimelineStatusRow>();
  return results ?? [];
}

export type RecommendationCandidateWindowOptions = {
  readonly viewerAccountId: string;
  readonly upperBound: string;
  readonly excludedIds: readonly string[];
  readonly limit: number;
};

/**
 * Fetch one rolling recommendation window from the public/home union.
 *
 * Previously displayed or invalidated originals are removed inside D1 through
 * one JSON binding. Boost wrappers are normalized to their original status ID,
 * while the wrapper and original must both still satisfy their respective
 * home-surface permissions. The fixed upper bound prevents posts created after
 * a refresh from leaking into that refresh's later pages.
 */
export async function getRecommendationCandidateWindow({
  viewerAccountId,
  upperBound,
  excludedIds,
  limit,
}: RecommendationCandidateWindowOptions): Promise<TimelineStatusRow[]> {
  const candidateLimit = Math.min(200, Math.max(1, Math.trunc(limit)));
  const sourceScanLimit = Math.min(
    RECOMMENDATION_SOURCE_SCAN_LIMIT,
    candidateLimit * RECOMMENDATION_SOURCE_SCAN_MULTIPLIER,
  );
  const now = new Date().toISOString();
  const directMembership = buildHomeTimelineMembershipPredicate(viewerAccountId);
  const directVisibility = buildStatusVisibilitySqlPredicate('status', viewerAccountId);
  const directRelationship = buildStatusRelationshipSqlPredicate(
    'status',
    viewerAccountId,
    now,
  );
  const boostMembership = buildHomeTimelineMembershipPredicate(viewerAccountId);
  const boostVisibility = buildStatusVisibilitySqlPredicate('status', viewerAccountId);
  const boostRelationship = buildStatusRelationshipSqlPredicate(
    'status',
    viewerAccountId,
    now,
  );
  const originalVisibility = buildStatusVisibilitySqlPredicate(
    'reblogged_status',
    viewerAccountId,
  );
  const originalRelationship = buildStatusRelationshipSqlPredicate(
    'reblogged_status',
    viewerAccountId,
    now,
  );

  const sql = `
    WITH excluded_ids(id) AS MATERIALIZED (
      SELECT CAST(value AS TEXT)
      FROM json_each(?)
    ), recent_direct_surfaces(surface_id) AS MATERIALIZED (
      SELECT s.id
      FROM statuses s INDEXED BY idx_statuses_recommendation_original_cursor
      WHERE s.created_at <= ?
        AND s.reblog_of_id IS NULL
        AND s.deleted_at IS NULL
        AND s.visibility != 'direct'
        AND NOT EXISTS (
          SELECT 1
          FROM excluded_ids excluded
          WHERE excluded.id = s.id
        )
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT ?
    ), recent_boost_surfaces(surface_id) AS MATERIALIZED (
      SELECT s.id
      FROM statuses s INDEXED BY idx_statuses_recommendation_boost_cursor
      JOIN statuses rs ON rs.id = s.reblog_of_id
      WHERE s.created_at <= ?
        AND s.reblog_of_id IS NOT NULL
        AND s.deleted_at IS NULL
        AND s.visibility != 'direct'
        AND NOT EXISTS (
          SELECT 1
          FROM excluded_ids excluded
          WHERE excluded.id = rs.id
        )
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT ?
    ), candidate_sources(candidate_id, surface_created_at) AS (
      SELECT s.id, s.created_at
      FROM recent_direct_surfaces surface
      JOIN statuses s ON s.id = surface.surface_id
      WHERE s.reblog_of_id IS NULL
        AND s.deleted_at IS NULL
        AND s.visibility != 'direct'
        AND (s.visibility = 'public' OR ${directMembership.sql})
        AND ${directVisibility.sql}
        AND ${directRelationship.sql}

      UNION ALL

      SELECT rs.id, s.created_at
      FROM recent_boost_surfaces surface
      JOIN statuses s ON s.id = surface.surface_id
      JOIN statuses rs ON rs.id = s.reblog_of_id
      WHERE s.reblog_of_id IS NOT NULL
        AND s.deleted_at IS NULL
        AND s.visibility != 'direct'
        AND ${boostMembership.sql}
        AND ${boostVisibility.sql}
        AND ${boostRelationship.sql}
        AND rs.reblog_of_id IS NULL
        AND rs.deleted_at IS NULL
        AND rs.visibility != 'direct'
        AND ${originalVisibility.sql}
        AND ${originalRelationship.sql}
    ), recent_ids AS (
      SELECT source.candidate_id,
             MAX(source.surface_created_at) AS surface_created_at
      FROM candidate_sources source
      GROUP BY source.candidate_id
      ORDER BY surface_created_at DESC, source.candidate_id DESC
      LIMIT ?
    )
    SELECT s.*, ${ACCOUNT_COLUMNS}
    FROM recent_ids recent
    JOIN statuses s ON s.id = recent.candidate_id
    JOIN accounts a ON a.id = s.account_id
    ORDER BY recent.surface_created_at DESC, recent.candidate_id DESC
  `;
  const excludedJson = JSON.stringify([...new Set(excludedIds)]);
  const { results } = await env.DB.prepare(sql).bind(
    excludedJson,
    upperBound,
    sourceScanLimit,
    upperBound,
    sourceScanLimit,
    ...directMembership.bindings,
    ...directVisibility.bindings,
    ...directRelationship.bindings,
    ...boostMembership.bindings,
    ...boostVisibility.bindings,
    ...boostRelationship.bindings,
    ...originalVisibility.bindings,
    ...originalRelationship.bindings,
    candidateLimit,
  ).all<TimelineStatusRow>();
  return results ?? [];
}

/**
 * Re-fetch an ordered recommendation ID set through the public-or-home
 * membership, visibility, relationship, and account-state filters. Callers
 * restore their own ranking order after this query; this function returns only
 * rows that remain safe to show to the viewer now and never returns DMs.
 */
export async function getVisibleRecommendationStatusesByIds(
  statusIds: readonly string[],
  viewerAccountId: string,
): Promise<TimelineStatusRow[]> {
  const uniqueIds = [...new Set(statusIds)].slice(0, 200);
  if (uniqueIds.length === 0) return [];

  const now = new Date().toISOString();
  const homeMembership = buildHomeTimelineMembershipPredicate(viewerAccountId);
  const directVisibility = buildStatusVisibilitySqlPredicate('status', viewerAccountId);
  const directRelationship = buildStatusRelationshipSqlPredicate(
    'status',
    viewerAccountId,
    now,
  );
  const directConditions: string[] = [
    `(s.visibility = 'public' OR ${homeMembership.sql})`,
    `s.visibility != 'direct'`,
    's.deleted_at IS NULL',
    's.reblog_of_id IS NULL',
    directVisibility.sql,
    directRelationship.sql,
  ];
  const directBinds: (string | number)[] = [
    ...homeMembership.bindings,
    ...directVisibility.bindings,
    ...directRelationship.bindings,
  ];

  // A followed account's boost is a home-timeline surface even when the
  // original author is not followed. Normalize that eligible wrapper to the
  // original row without weakening either side's visibility/relationship
  // checks. The outer `rs` row is validated exactly once below; applying the
  // generic reblog-original surface predicate to wrapper `s` would reopen the
  // same original and repeat every permission subquery.
  const originalVisibility = buildStatusVisibilitySqlPredicate(
    'reblogged_status',
    viewerAccountId,
  );
  const originalRelationship = buildStatusRelationshipSqlPredicate(
    'reblogged_status',
    viewerAccountId,
    now,
  );
  const originalConditions: string[] = [
    'rs.deleted_at IS NULL',
    'rs.reblog_of_id IS NULL',
    `rs.visibility != 'direct'`,
    originalVisibility.sql,
    originalRelationship.sql,
  ];
  const originalBinds: (string | number)[] = [
    ...originalVisibility.bindings,
    ...originalRelationship.bindings,
  ];
  const boostMembership = buildHomeTimelineMembershipPredicate(viewerAccountId);
  const boostVisibility = buildStatusVisibilitySqlPredicate('status', viewerAccountId);
  const boostRelationship = buildStatusRelationshipSqlPredicate(
    'status',
    viewerAccountId,
    now,
  );
  const boostConditions: string[] = [
    boostMembership.sql,
    's.deleted_at IS NULL',
    `s.visibility != 'direct'`,
    's.reblog_of_id IS NOT NULL',
    boostVisibility.sql,
    boostRelationship.sql,
  ];
  const boostBinds: (string | number)[] = [
    ...boostMembership.bindings,
    ...boostVisibility.bindings,
    ...boostRelationship.bindings,
  ];

  // Keep candidate IDs as direct PK predicates. A json_each/UNION CTE caused
  // SQLite to materialize the boost branch before narrowing to candidate IDs,
  // reading millions of rows for a 60-ID recommendation reservoir. D1 batch
  // keeps the two indexed statements in one binding round trip without giving
  // the planner an opportunity to reorder them into a global scan.
  const visibleById = new Map<string, TimelineStatusRow>();
  for (
    let offset = 0;
    offset < uniqueIds.length;
    offset += RECOMMENDATION_ID_QUERY_BATCH_SIZE
  ) {
    const batchIds = uniqueIds.slice(
      offset,
      offset + RECOMMENDATION_ID_QUERY_BATCH_SIZE,
    );
    const placeholders = batchIds.map(() => '?').join(', ');
    const directSql = `
      SELECT /* recommendation-direct-revalidation */ s.*, ${ACCOUNT_COLUMNS}
      FROM statuses s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.id IN (${placeholders})
        AND ${directConditions.join(' AND ')}
    `;
    const boostSql = `
      SELECT /* recommendation-boost-revalidation */ rs.*, ${ACCOUNT_COLUMNS}
      FROM statuses rs
      JOIN accounts a ON a.id = rs.account_id
      WHERE rs.id IN (${placeholders})
        AND ${originalConditions.join(' AND ')}
        AND EXISTS (
          SELECT 1
          FROM statuses s
          WHERE s.reblog_of_id = rs.id
            AND ${boostConditions.join(' AND ')}
        )
    `;
    const [directResult, boostResult] = await env.DB.batch<TimelineStatusRow>([
      env.DB.prepare(directSql).bind(...batchIds, ...directBinds),
      env.DB.prepare(boostSql).bind(
        ...batchIds,
        ...originalBinds,
        ...boostBinds,
      ),
    ]);
    for (const row of [
      ...(directResult.results ?? []),
      ...(boostResult.results ?? []),
    ]) {
      visibleById.set(row.id, row);
    }
  }
  return [...visibleById.values()];
}

// ----------------------------------------------------------------
// Tag timeline
// ----------------------------------------------------------------

export async function getTagTimeline(
  tag: string,
  opts: TagTimelineOpts,
): Promise<TimelineStatusRow[]> {
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

  const { results } = await env.DB.prepare(sql).bind(...binds).all<TimelineStatusRow>();
  return results ?? [];
}

// ----------------------------------------------------------------
// List timeline
// ----------------------------------------------------------------

export async function getListTimeline(
  listId: string,
  accountId: string,
  opts: TimelinePaginationOpts,
): Promise<TimelineStatusRow[]> {
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

  const { results } = await env.DB.prepare(sql).bind(...binds).all<TimelineStatusRow>();
  return results ?? [];
}
