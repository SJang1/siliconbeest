import { env } from 'cloudflare:workers';
import {
  canSurfaceStatus,
  canViewStatus,
} from '../../../../packages/shared/permissions';
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

export const RECOMMENDATION_PUBLIC_SOURCE_LIMIT = 250;
export const RECOMMENDATION_HOME_SOURCE_LIMIT = 100;
export const RECOMMENDATION_CANDIDATE_WINDOW_LIMIT =
  RECOMMENDATION_PUBLIC_SOURCE_LIMIT + RECOMMENDATION_HOME_SOURCE_LIMIT;

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

type RecommendationSurfaceRow = {
  readonly surface_id: string;
  readonly candidate_id: string;
  readonly surface_created_at: string;
  readonly source_kind: 'direct' | 'boost';
};

type RecommendationAuthorFactRow = {
  readonly id: string;
  readonly domain: string | null;
  readonly suspended_at: string | null;
  readonly silenced_at: string | null;
};

type RecommendationPermissionStatusRow = {
  readonly id: string;
  readonly account_id: string;
  readonly visibility: string | null;
  readonly deleted_at: string | null;
  readonly reblog_of_id: string | null;
};

type RecommendationFollowFactRow = {
  readonly target_account_id: string;
  readonly show_reblogs: number | null;
};

type RecommendationAccountFactRow = {
  readonly account_id: string;
};

type RecommendationMentionFactRow = {
  readonly status_id: string;
};

type RecommendationPermissionBatchRow =
  | TimelineStatusRow
  | RecommendationPermissionStatusRow
  | RecommendationAuthorFactRow
  | RecommendationFollowFactRow
  | RecommendationAccountFactRow
  | RecommendationMentionFactRow;

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
  const candidateLimit = Math.min(
    RECOMMENDATION_CANDIDATE_WINDOW_LIMIT,
    Math.max(1, Math.trunc(limit)),
  );
  const publicSourceLimit = Math.min(RECOMMENDATION_PUBLIC_SOURCE_LIMIT, candidateLimit);
  const homeSourceLimit = Math.min(RECOMMENDATION_HOME_SOURCE_LIMIT, candidateLimit);
  const combinedSourceScanLimit = Math.min(
    RECOMMENDATION_CANDIDATE_WINDOW_LIMIT,
    publicSourceLimit + homeSourceLimit,
  );
  const homeMembership = buildHomeTimelineMembershipPredicate(viewerAccountId);
  const publicSourceSql = `
    /* recommendation-public-source */
    WITH excluded_ids(id) AS MATERIALIZED (
      SELECT CAST(value AS TEXT)
      FROM json_each(?)
    ), latest_own_status(id) AS MATERIALIZED (
      SELECT own.id
      FROM statuses own INDEXED BY idx_statuses_account_timeline
      WHERE own.account_id = ?
        AND own.created_at <= ?
        AND own.reblog_of_id IS NULL
        AND own.deleted_at IS NULL
        AND own.visibility IN ('public', 'unlisted', 'private')
      ORDER BY own.created_at DESC, own.id DESC
      LIMIT 1
    )
    SELECT s.id AS surface_id,
           s.id AS candidate_id,
           s.created_at AS surface_created_at,
           'direct' AS source_kind
    FROM statuses s INDEXED BY idx_statuses_recommendation_original_cursor
    WHERE s.created_at <= ?
      AND s.reblog_of_id IS NULL
      AND s.deleted_at IS NULL
      AND s.visibility = 'public'
      AND (
        s.account_id != ?
        OR EXISTS (SELECT 1 FROM latest_own_status own WHERE own.id = s.id)
      )
      AND NOT EXISTS (
        SELECT 1 FROM excluded_ids excluded WHERE excluded.id = s.id
      )
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT ?
  `;
  const homeSourceSql = `
    /* recommendation-home-source */
    WITH excluded_ids(id) AS MATERIALIZED (
      SELECT CAST(value AS TEXT)
      FROM json_each(?)
    ), latest_own_status(id) AS MATERIALIZED (
      SELECT own.id
      FROM statuses own INDEXED BY idx_statuses_account_timeline
      WHERE own.account_id = ?
        AND own.created_at <= ?
        AND own.reblog_of_id IS NULL
        AND own.deleted_at IS NULL
        AND own.visibility IN ('public', 'unlisted', 'private')
      ORDER BY own.created_at DESC, own.id DESC
      LIMIT 1
    )
    SELECT s.id AS surface_id,
           COALESCE(s.reblog_of_id, s.id) AS candidate_id,
           s.created_at AS surface_created_at,
           CASE WHEN s.reblog_of_id IS NULL THEN 'direct' ELSE 'boost' END AS source_kind
    FROM statuses s INDEXED BY idx_statuses_timeline_cursor
    JOIN statuses candidate ON candidate.id = COALESCE(s.reblog_of_id, s.id)
    WHERE s.created_at <= ?
      AND s.deleted_at IS NULL
      AND s.visibility != 'direct'
      AND ${homeMembership.sql}
      AND (
        candidate.account_id != ?
        OR EXISTS (
          SELECT 1 FROM latest_own_status own WHERE own.id = candidate.id
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM excluded_ids excluded
        WHERE excluded.id = COALESCE(s.reblog_of_id, s.id)
      )
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT ?
  `;
  const excludedJson = JSON.stringify([...new Set(excludedIds)]);
  const [publicSourceResult, homeSourceResult] = await env.DB.batch<RecommendationSurfaceRow>([
    env.DB.prepare(publicSourceSql).bind(
      excludedJson,
      viewerAccountId,
      upperBound,
      upperBound,
      viewerAccountId,
      publicSourceLimit,
    ),
    env.DB.prepare(homeSourceSql).bind(
      excludedJson,
      viewerAccountId,
      upperBound,
      upperBound,
      ...homeMembership.bindings,
      viewerAccountId,
      homeSourceLimit,
    ),
  ]);
  const surfaces = [
    ...(publicSourceResult.results ?? []),
    ...(homeSourceResult.results ?? []),
  ]
    .sort((left, right) => (
      right.surface_created_at.localeCompare(left.surface_created_at)
      || right.surface_id.localeCompare(left.surface_id)
    ))
    .slice(0, combinedSourceScanLimit);
  if (surfaces.length === 0) return [];

  const requestedStatusIds = [...new Set(surfaces.flatMap((surface) => [
    surface.surface_id,
    surface.candidate_id,
  ]))];
  const requestedJson = JSON.stringify(requestedStatusIds);
  const candidateJson = JSON.stringify([
    ...new Set(surfaces.map((surface) => surface.candidate_id)),
  ]);
  const now = new Date().toISOString();
  const requestedStatusesCte = `
    WITH requested_ids(id) AS MATERIALIZED (
      SELECT CAST(value AS TEXT) FROM json_each(?)
    )`;
  const candidateAuthorsCte = `${requestedStatusesCte},
    candidate_authors AS MATERIALIZED (
      SELECT DISTINCT a.id, a.domain, a.suspended_at, a.silenced_at
      FROM requested_ids requested
      JOIN statuses s ON s.id = requested.id
      JOIN accounts a ON a.id = s.account_id
    )`;

  // D1 executes these simple indexed lookups in one binding round trip. The
  // shared permission functions below replace hundreds of correlated
  // subqueries while retaining the exact visibility and relationship policy.
  const permissionResults = await env.DB.batch<RecommendationPermissionBatchRow>([
    env.DB.prepare(
      `${requestedStatusesCte}
       SELECT s.*, ${ACCOUNT_COLUMNS}
       FROM requested_ids requested
       JOIN statuses s ON s.id = requested.id
       JOIN accounts a ON a.id = s.account_id`,
    ).bind(candidateJson),
    env.DB.prepare(
      `${requestedStatusesCte}
       SELECT s.id, s.account_id, s.visibility, s.deleted_at, s.reblog_of_id
       FROM requested_ids requested
       JOIN statuses s ON s.id = requested.id`,
    ).bind(requestedJson),
    env.DB.prepare(
      `${candidateAuthorsCte}
       SELECT id, domain, suspended_at, silenced_at
       FROM candidate_authors`,
    ).bind(requestedJson),
    env.DB.prepare(
      `${candidateAuthorsCte}
       SELECT f.target_account_id, f.show_reblogs
       FROM candidate_authors author
       JOIN follows f
         ON f.account_id = ?
        AND f.target_account_id = author.id`,
    ).bind(requestedJson, viewerAccountId),
    env.DB.prepare(
      `${candidateAuthorsCte}
       SELECT m.target_account_id AS account_id
       FROM candidate_authors author
       JOIN mutes m
         ON m.account_id = ?
        AND m.target_account_id = author.id
       WHERE m.expires_at IS NULL OR m.expires_at > ?`,
    ).bind(requestedJson, viewerAccountId, now),
    env.DB.prepare(
      `${candidateAuthorsCte}
       SELECT b.target_account_id AS account_id
       FROM candidate_authors author
       JOIN blocks b
         ON b.account_id = ?
        AND b.target_account_id = author.id`,
    ).bind(requestedJson, viewerAccountId),
    env.DB.prepare(
      `${candidateAuthorsCte}
       SELECT b.account_id
       FROM candidate_authors author
       JOIN blocks b
         ON b.account_id = author.id
        AND b.target_account_id = ?`,
    ).bind(requestedJson, viewerAccountId),
    env.DB.prepare(
      `${candidateAuthorsCte}
       SELECT author.id AS account_id
       FROM candidate_authors author
       JOIN user_domain_blocks domain_block
         ON domain_block.account_id = ?
        AND author.domain IS NOT NULL
        AND lower(domain_block.domain) = lower(author.domain)`,
    ).bind(requestedJson, viewerAccountId),
    env.DB.prepare(
      `${requestedStatusesCte}
       SELECT mention.status_id
       FROM requested_ids requested
       JOIN mentions mention
         ON mention.status_id = requested.id
        AND mention.account_id = ?`,
    ).bind(requestedJson, viewerAccountId),
  ]);

  const candidates = (permissionResults[0]?.results ?? []) as TimelineStatusRow[];
  const statuses = (permissionResults[1]?.results ?? []) as RecommendationPermissionStatusRow[];
  const authors = (permissionResults[2]?.results ?? []) as RecommendationAuthorFactRow[];
  const follows = (permissionResults[3]?.results ?? []) as RecommendationFollowFactRow[];
  const mutedAuthors = (permissionResults[4]?.results ?? []) as RecommendationAccountFactRow[];
  const viewerBlockedAuthors = (permissionResults[5]?.results ?? []) as RecommendationAccountFactRow[];
  const viewerBlockingAuthors = (permissionResults[6]?.results ?? []) as RecommendationAccountFactRow[];
  const domainBlockedAuthors = (permissionResults[7]?.results ?? []) as RecommendationAccountFactRow[];
  const mentions = (permissionResults[8]?.results ?? []) as RecommendationMentionFactRow[];

  const candidateByStatusId = new Map(candidates.map((status) => [status.id, status] as const));
  const statusById = new Map(statuses.map((status) => [status.id, status] as const));
  const authorById = new Map(authors.map((author) => [author.id, author] as const));
  const followByAuthorId = new Map(
    follows.map((follow) => [follow.target_account_id, follow] as const),
  );
  const mutedAuthorIds = new Set(mutedAuthors.map((row) => row.account_id));
  const viewerBlockedAuthorIds = new Set(viewerBlockedAuthors.map((row) => row.account_id));
  const viewerBlockingAuthorIds = new Set(viewerBlockingAuthors.map((row) => row.account_id));
  const domainBlockedAuthorIds = new Set(domainBlockedAuthors.map((row) => row.account_id));
  const mentionedStatusIds = new Set(mentions.map((row) => row.status_id));

  const canSurface = (status: RecommendationPermissionStatusRow): boolean => {
    const authorId = status.account_id;
    const author = authorById.get(authorId);
    if (!author) return false;
    const viewerFollowsAuthor = followByAuthorId.has(authorId);
    const statusViewable = canViewStatus({
      visibility: status.visibility,
      viewerAccountId,
      authorAccountId: authorId,
      viewerFollowsAuthor,
      viewerIsMentioned: mentionedStatusIds.has(status.id),
      authorBlocksViewer: viewerBlockingAuthorIds.has(authorId),
      statusDeleted: status.deleted_at !== null,
    });
    return canSurfaceStatus({
      statusViewable,
      authorSuspended: author.suspended_at !== null,
      authorSilenced: author.silenced_at !== null,
      viewerIsAuthor: viewerAccountId === authorId,
      viewerFollowsAuthor,
      viewerMutesAuthor: mutedAuthorIds.has(authorId),
      viewerBlocksAuthor: viewerBlockedAuthorIds.has(authorId),
      viewerBlocksAuthorDomain: domainBlockedAuthorIds.has(authorId),
      authorBlocksViewer: viewerBlockingAuthorIds.has(authorId),
    });
  };
  const isHomeMember = (
    status: RecommendationPermissionStatusRow,
    requireReblogConsent: boolean,
  ): boolean => {
    if (status.account_id === viewerAccountId) return true;
    const follow = followByAuthorId.get(status.account_id);
    if (!follow || status.visibility === 'direct') return false;
    return !requireReblogConsent || (follow.show_reblogs ?? 1) !== 0;
  };

  const candidateById = new Map<
    string,
    { readonly row: TimelineStatusRow; readonly surfaceCreatedAt: string }
  >();
  surfaces.forEach((surface) => {
    if (candidateById.has(surface.candidate_id)) return;
    const status = statusById.get(surface.surface_id);
    const candidate = statusById.get(surface.candidate_id);
    const candidateRow = candidateByStatusId.get(surface.candidate_id);
    if (!status || !candidate || !candidateRow) return;

    const directAllowed = surface.source_kind === 'direct'
      && surface.surface_id === surface.candidate_id
      && status.reblog_of_id === null
      && status.visibility !== 'direct'
      && (status.visibility === 'public' || isHomeMember(status, false))
      && canSurface(status);
    const boostAllowed = surface.source_kind === 'boost'
      && status.reblog_of_id === surface.candidate_id
      && status.visibility !== 'direct'
      && isHomeMember(status, true)
      && canSurface(status)
      && candidate.reblog_of_id === null
      && candidate.visibility !== 'direct'
      && canSurface(candidate);
    if (!directAllowed && !boostAllowed) return;
    candidateById.set(surface.candidate_id, {
      row: candidateRow,
      surfaceCreatedAt: surface.surface_created_at,
    });
  });

  return [...candidateById.entries()]
    .sort(([leftId, left], [rightId, right]) => (
      right.surfaceCreatedAt.localeCompare(left.surfaceCreatedAt)
      || rightId.localeCompare(leftId)
    ))
    .slice(0, candidateLimit)
    .map(([, candidate]) => candidate.row);
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
