import { env } from 'cloudflare:workers';
import {
  canAttachMediaToStatus,
  canAddAccountToList,
  canFeatureAccount,
  canFollowAccount,
  canCreateBlockOrMuteAccountRelationship,
  canInteractWithStatus,
  canModerateAccount,
  canMutateOwnedStatus,
  canApplyFederatedActorUpdate,
  canApplyFederatedDelete,
  canAcceptFederatedReport,
  canExposeStatusInActivityPubPublicCollection,
  canOriginateAccountActivity,
  canProcessFollowRequest,
  canProcessFederatedAccountTarget,
  canProcessFederatedMove,
  canRefollowAfterFederatedMove,
  canReceiveFederatedFollow,
  canUndoFederatedAccountAction,
  canQuoteStatus,
  canReblogStatus,
  canViewAccountCollection,
  canViewAccount,
  canViewStatus,
  canVoteInPoll,
  parseStatusVisibility,
  resolveStatusCreationVisibility,
  type OwnedStatusMutation,
  type StatusVisibility,
} from '../../../../packages/shared/permissions';
import { getSuspendedDomains } from '../../../../packages/shared/domain-blocks';
import { AppError } from '../middleware/errorHandler';
import type { FollowRequestRow } from '../types/db';

export type StatusPermissionRecord = {
  id: string;
  account_id: string | null;
  visibility: string | null;
  deleted_at: string | null;
};

export type StatusQuotePermissionRecord = StatusPermissionRecord & {
  quote_policy: string | null;
  quote_policy_automatic_approvals?: string | null;
  quote_policy_manual_approvals?: string | null;
};

export type StatusMutationPermissionRecord = StatusPermissionRecord & {
  local: number | null;
  reblog_of_id: string | null;
};

export type PollVotePermissionRecord = StatusPermissionRecord & {
  expires_at: string | null;
};

export type MediaAttachmentPermissionRecord = {
  id: string;
  account_id: string | null;
  status_id: string | null;
};

export type AccountPermissionRecord = {
  id: string;
  domain: string | null;
  suspended_at: string | null;
};

type AccountCollectionPermissionRecord = {
  id: string;
  hide_collections: number | null;
};

type AccountOperationalPermissionFields = {
  domain: string | null;
  suspended_at: string | null;
  memorial: number | null;
  user_disabled: number | null;
  user_approved: number | null;
};

type FollowRequestActionPermissionRecord = FollowRequestRow
  & AccountOperationalPermissionFields
  & {
    requester_blocks_target: number;
    target_blocks_requester: number;
    target_blocks_requester_domain: number;
  };

type ListMemberPermissionRecord = AccountOperationalPermissionFields & {
  list_owner_account_id: string;
  member_account_id: string;
  follow_id: string | null;
  actor_blocks_member: number;
  member_blocks_actor: number;
};

export type PermissionSqlPredicate = {
  sql: string;
  bindings: string[];
};

export const STATUS_PERMISSION_SQL_SOURCES = [
  'status',
  'quoted_status',
  'reblogged_status',
  'notification_status',
] as const;

export type StatusPermissionSqlSource =
  (typeof STATUS_PERMISSION_SQL_SOURCES)[number];

export const NOTIFICATION_ACCOUNT_SQL_SOURCES = [
  'notification_sender',
  'notification_status_author',
] as const;

export type NotificationAccountSqlSource =
  (typeof NOTIFICATION_ACCOUNT_SQL_SOURCES)[number];

export const ACCOUNT_PERMISSION_SQL_SOURCES = ['account'] as const;

export type AccountPermissionSqlSource =
  (typeof ACCOUNT_PERMISSION_SQL_SOURCES)[number];

type StatusPermissionSqlAlias = 's' | 'qs' | 'rs' | 'permission_status';
type NotificationAccountSqlAlias = 'a' | 'notification_status_author';
type AccountPermissionSqlAlias = 'a';

function resolveStatusPermissionSqlAlias(
  source: StatusPermissionSqlSource,
): StatusPermissionSqlAlias {
  switch (source) {
    case 'status':
      return 's';
    case 'quoted_status':
      return 'qs';
    case 'reblogged_status':
      return 'rs';
    case 'notification_status':
      return 'permission_status';
    default:
      // eslint-disable-next-line functional/no-throw-statements -- Runtime callers must fail closed after an unsafe cast.
      throw new Error('Invalid SQL source');
  }
}

function resolveNotificationAccountSqlAlias(
  source: NotificationAccountSqlSource,
): NotificationAccountSqlAlias {
  switch (source) {
    case 'notification_sender':
      return 'a';
    case 'notification_status_author':
      return 'notification_status_author';
    default:
      // eslint-disable-next-line functional/no-throw-statements -- Runtime callers must fail closed after an unsafe cast.
      throw new Error('Invalid SQL source');
  }
}

function resolveAccountPermissionSqlAlias(
  source: AccountPermissionSqlSource,
): AccountPermissionSqlAlias {
  switch (source) {
    case 'account':
      return 'a';
    default:
      // eslint-disable-next-line functional/no-throw-statements -- Runtime callers must fail closed after an unsafe cast.
      throw new Error('Invalid SQL source');
  }
}

/**
 * Builds canonical account availability for public API resources. Disabled
 * accounts remain readable because freeze is an action/authentication state;
 * suspension is the profile-removal boundary.
 */
export function buildAccountAvailabilitySqlPredicate(
  source: AccountPermissionSqlSource,
): PermissionSqlPredicate {
  const alias = resolveAccountPermissionSqlAlias(source);
  return {
    sql: `(${alias}.suspended_at IS NULL)`,
    bindings: [],
  };
}

/**
 * Filters accounts exposed through interaction participant collections such
 * as favourited_by and reblogged_by. These collections are surfaces, so they
 * exclude suspended actors and viewer-specific mutes, bilateral blocks, and
 * blocked remote domains without applying unrelated discovery restrictions.
 */
export function buildAccountInteractionListSqlPredicate(
  source: AccountPermissionSqlSource,
  viewerAccountId: string | null,
  now: string,
): PermissionSqlPredicate {
  const alias = resolveAccountPermissionSqlAlias(source);
  const availability = buildAccountAvailabilitySqlPredicate(source);
  if (!viewerAccountId) return availability;

  return {
    sql: `(
      ${availability.sql}
      AND NOT EXISTS (
        SELECT 1 FROM mutes interaction_list_mute
        WHERE interaction_list_mute.account_id = ?
          AND interaction_list_mute.target_account_id = ${alias}.id
          AND (interaction_list_mute.expires_at IS NULL OR interaction_list_mute.expires_at > ?)
      )
      AND NOT EXISTS (
        SELECT 1 FROM blocks interaction_list_viewer_block
        WHERE interaction_list_viewer_block.account_id = ?
          AND interaction_list_viewer_block.target_account_id = ${alias}.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM blocks interaction_list_actor_block
        WHERE interaction_list_actor_block.account_id = ${alias}.id
          AND interaction_list_actor_block.target_account_id = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM user_domain_blocks interaction_list_domain_block
        WHERE interaction_list_domain_block.account_id = ?
          AND ${alias}.domain IS NOT NULL
          AND lower(interaction_list_domain_block.domain) = lower(${alias}.domain)
      )
    )`,
    bindings: [
      viewerAccountId,
      now,
      viewerAccountId,
      viewerAccountId,
      viewerAccountId,
    ],
  };
}

/**
 * Builds account discovery suppression. Logical sources map to fixed internal
 * aliases, so account IDs, handles, and search terms remain bound values and
 * can never become SQL identifiers.
 */
export function buildAccountDiscoverySqlPredicate(
  source: AccountPermissionSqlSource,
  viewerAccountId: string | null,
  now: string,
): PermissionSqlPredicate {
  const alias = resolveAccountPermissionSqlAlias(source);
  const availability = buildAccountAvailabilitySqlPredicate(source);
  if (!viewerAccountId) {
    return {
      sql: `(
        ${availability.sql}
        AND (
          ${alias}.domain IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM users account_discovery_owner
            WHERE account_discovery_owner.account_id = ${alias}.id
              AND account_discovery_owner.approved = 1
          )
        )
        AND ${alias}.silenced_at IS NULL
      )`,
      bindings: [],
    };
  }

  return {
    sql: `(
      ${availability.sql}
      AND (
        ${alias}.domain IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM users account_discovery_owner
          WHERE account_discovery_owner.account_id = ${alias}.id
            AND account_discovery_owner.approved = 1
        )
      )
      AND (
        ${alias}.silenced_at IS NULL
        OR ${alias}.id = ?
        OR EXISTS (
          SELECT 1 FROM follows account_discovery_follow
          WHERE account_discovery_follow.account_id = ?
            AND account_discovery_follow.target_account_id = ${alias}.id
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM mutes account_discovery_mute
        WHERE account_discovery_mute.account_id = ?
          AND account_discovery_mute.target_account_id = ${alias}.id
          AND (account_discovery_mute.expires_at IS NULL OR account_discovery_mute.expires_at > ?)
      )
      AND NOT EXISTS (
        SELECT 1 FROM blocks account_discovery_viewer_block
        WHERE account_discovery_viewer_block.account_id = ?
          AND account_discovery_viewer_block.target_account_id = ${alias}.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM blocks account_discovery_target_block
        WHERE account_discovery_target_block.account_id = ${alias}.id
          AND account_discovery_target_block.target_account_id = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM user_domain_blocks account_discovery_domain_block
        WHERE account_discovery_domain_block.account_id = ?
          AND ${alias}.domain IS NOT NULL
          AND lower(account_discovery_domain_block.domain) = lower(${alias}.domain)
      )
    )`,
    bindings: [
      viewerAccountId,
      viewerAccountId,
      viewerAccountId,
      now,
      viewerAccountId,
      viewerAccountId,
      viewerAccountId,
    ],
  };
}

/**
 * Builds non-exact account search rules. Limited accounts remain searchable;
 * moved, pending, suspended, muted, and bilaterally blocked accounts do not.
 */
export function buildAccountSearchSqlPredicate(
  source: AccountPermissionSqlSource,
  viewerAccountId: string | null,
  now: string,
): PermissionSqlPredicate {
  const alias = resolveAccountPermissionSqlAlias(source);
  const availability = buildAccountAvailabilitySqlPredicate(source);
  const searchableAccountSql = `(
    ${availability.sql}
    AND ${alias}.moved_to_account_id IS NULL
    AND (
      ${alias}.domain IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM users account_search_owner
        WHERE account_search_owner.account_id = ${alias}.id
          AND account_search_owner.approved = 1
      )
    )
  )`;
  if (!viewerAccountId) {
    return { sql: searchableAccountSql, bindings: [] };
  }

  return {
    sql: `(
      ${searchableAccountSql}
      AND NOT EXISTS (
        SELECT 1 FROM mutes account_search_mute
        WHERE account_search_mute.account_id = ?
          AND account_search_mute.target_account_id = ${alias}.id
          AND (account_search_mute.expires_at IS NULL OR account_search_mute.expires_at > ?)
      )
      AND NOT EXISTS (
        SELECT 1 FROM blocks account_search_viewer_block
        WHERE account_search_viewer_block.account_id = ?
          AND account_search_viewer_block.target_account_id = ${alias}.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM blocks account_search_target_block
        WHERE account_search_target_block.account_id = ${alias}.id
          AND account_search_target_block.target_account_id = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM user_domain_blocks account_search_domain_block
        WHERE account_search_domain_block.account_id = ?
          AND ${alias}.domain IS NOT NULL
          AND lower(account_search_domain_block.domain) = lower(${alias}.domain)
      )
    )`,
    bindings: [
      viewerAccountId,
      now,
      viewerAccountId,
      viewerAccountId,
      viewerAccountId,
    ],
  };
}

/**
 * Builds the canonical status-visibility predicate for list queries.
 * Logical sources resolve to fixed internal aliases; request input is never
 * interpolated as an SQL identifier.
 */
export function buildStatusVisibilitySqlPredicate(
  source: StatusPermissionSqlSource,
  viewerAccountId: string | null,
): PermissionSqlPredicate {
  const alias = resolveStatusPermissionSqlAlias(source);

  if (!viewerAccountId) {
    return {
      sql: `(
        ${alias}.deleted_at IS NULL
        AND ${alias}.visibility IN ('public', 'unlisted')
        AND EXISTS (
          SELECT 1 FROM accounts permission_author
          WHERE permission_author.id = ${alias}.account_id
            AND permission_author.suspended_at IS NULL
        )
      )`,
      bindings: [],
    };
  }

  return {
    sql: `(
      ${alias}.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM accounts permission_author
        WHERE permission_author.id = ${alias}.account_id
          AND permission_author.suspended_at IS NULL
      )
      AND (
        (
          ${alias}.visibility IN ('public', 'unlisted')
          AND NOT EXISTS (
            SELECT 1 FROM blocks permission_author_block
            WHERE permission_author_block.account_id = ${alias}.account_id
              AND permission_author_block.target_account_id = ?
          )
        )
        OR (${alias}.visibility IN ('private', 'direct') AND ${alias}.account_id = ?)
        OR (
          ${alias}.visibility = 'private'
          AND EXISTS (
            SELECT 1 FROM follows permission_follow
            WHERE permission_follow.account_id = ?
              AND permission_follow.target_account_id = ${alias}.account_id
          )
        )
        OR (
          ${alias}.visibility IN ('private', 'direct')
          AND EXISTS (
            SELECT 1 FROM mentions permission_mention
            WHERE permission_mention.status_id = ${alias}.id
              AND permission_mention.account_id = ?
          )
        )
      )
    )`,
    bindings: [viewerAccountId, viewerAccountId, viewerAccountId, viewerAccountId],
  };
}

/**
 * Builds timeline/notification suppression rules. This is deliberately
 * separate from canonical visibility so direct resource fetches remain
 * unaffected by mute and block relationships.
 */
export function buildStatusRelationshipSqlPredicate(
  source: StatusPermissionSqlSource,
  viewerAccountId: string | null,
  now: string,
): PermissionSqlPredicate {
  const alias = resolveStatusPermissionSqlAlias(source);

  const activeAuthorSql = viewerAccountId
    ? `EXISTS (
      SELECT 1 FROM accounts relationship_author
      WHERE relationship_author.id = ${alias}.account_id
        AND relationship_author.suspended_at IS NULL
        AND (
          relationship_author.silenced_at IS NULL
          OR relationship_author.id = ?
          OR EXISTS (
            SELECT 1 FROM follows relationship_follow
            WHERE relationship_follow.account_id = ?
              AND relationship_follow.target_account_id = relationship_author.id
          )
        )
    )`
    : `EXISTS (
      SELECT 1 FROM accounts relationship_author
      WHERE relationship_author.id = ${alias}.account_id
        AND relationship_author.suspended_at IS NULL
        AND relationship_author.silenced_at IS NULL
    )`;
  if (!viewerAccountId) {
    return { sql: `(${activeAuthorSql})`, bindings: [] };
  }

  return {
    sql: `(
      ${activeAuthorSql}
      AND NOT EXISTS (
        SELECT 1 FROM mutes relationship_mute
        WHERE relationship_mute.account_id = ?
          AND relationship_mute.target_account_id = ${alias}.account_id
          AND (relationship_mute.expires_at IS NULL OR relationship_mute.expires_at > ?)
      )
      AND NOT EXISTS (
        SELECT 1 FROM blocks relationship_viewer_block
        WHERE relationship_viewer_block.account_id = ?
          AND relationship_viewer_block.target_account_id = ${alias}.account_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM blocks relationship_author_block
        WHERE relationship_author_block.account_id = ${alias}.account_id
          AND relationship_author_block.target_account_id = ?
      )
      AND NOT EXISTS (
        SELECT 1
        FROM user_domain_blocks relationship_domain_block
        JOIN accounts relationship_domain_author
          ON relationship_domain_author.id = ${alias}.account_id
        WHERE relationship_domain_block.account_id = ?
          AND relationship_domain_author.domain IS NOT NULL
          AND lower(relationship_domain_block.domain) = lower(relationship_domain_author.domain)
      )
    )`,
    bindings: [
      viewerAccountId,
      viewerAccountId,
      viewerAccountId,
      now,
      viewerAccountId,
      viewerAccountId,
      viewerAccountId,
    ],
  };
}

/**
 * Ensures a boost wrapper never outlives or bypasses the original status's
 * surface permissions. Both aliases are fixed here: wrapper `s` and original
 * `rs`; request data is restricted to bindings in the composed predicates.
 */
export function buildReblogOriginalSurfaceSqlPredicate(
  viewerAccountId: string | null,
  now: string,
): PermissionSqlPredicate {
  const visibility = buildStatusVisibilitySqlPredicate(
    'reblogged_status',
    viewerAccountId,
  );
  const relationship = buildStatusRelationshipSqlPredicate(
    'reblogged_status',
    viewerAccountId,
    now,
  );
  return {
    sql: `(
      s.reblog_of_id IS NULL
      OR EXISTS (
        SELECT 1 FROM statuses rs
        WHERE rs.id = s.reblog_of_id
          AND rs.reblog_of_id IS NULL
          AND rs.visibility IN ('public', 'unlisted')
          AND ${visibility.sql}
          AND ${relationship.sql}
      )
    )`,
    bindings: [
      ...visibility.bindings,
      ...relationship.bindings,
    ],
  };
}

/** Returns the original only when a stored boost wrapper may surface it. */
export async function getSurfaceableReblogOriginalId(
  statusId: string,
  viewerAccountId: string | null,
): Promise<string | null> {
  if (statusId.length === 0 || viewerAccountId === '') return null;
  const permission = buildReblogOriginalSurfaceSqlPredicate(
    viewerAccountId,
    new Date().toISOString(),
  );
  const original = await env.DB.prepare(
    `SELECT s.reblog_of_id AS id
     FROM statuses s
     WHERE s.id = ?
       AND s.deleted_at IS NULL
       AND s.reblog_of_id IS NOT NULL
       AND ${permission.sql}
     LIMIT 1`,
  ).bind(
    statusId,
    ...permission.bindings,
  ).first<{ id: string }>();
  return original?.id ?? null;
}

/** Applies account state and notification-specific relationship suppression. */
export function buildNotificationRelationshipSqlPredicate(
  source: NotificationAccountSqlSource,
  recipientAccountId: string,
  now: string,
): PermissionSqlPredicate {
  const accountAlias = resolveNotificationAccountSqlAlias(source);
  if (recipientAccountId.length === 0) {
    return { sql: '(1 = 0)', bindings: [] };
  }

  return {
    sql: `(
      ${accountAlias}.id IS NOT NULL
      AND ${accountAlias}.suspended_at IS NULL
      AND (
        ${accountAlias}.silenced_at IS NULL
        OR ${accountAlias}.id = ?
        OR EXISTS (
          SELECT 1 FROM follows notification_follow
          WHERE notification_follow.account_id = ?
            AND notification_follow.target_account_id = ${accountAlias}.id
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM mutes notification_mute
        WHERE notification_mute.account_id = ?
          AND notification_mute.target_account_id = ${accountAlias}.id
          AND notification_mute.hide_notifications != 0
          AND (notification_mute.expires_at IS NULL OR notification_mute.expires_at > ?)
      )
      AND NOT EXISTS (
        SELECT 1 FROM blocks notification_recipient_block
        WHERE notification_recipient_block.account_id = ?
          AND notification_recipient_block.target_account_id = ${accountAlias}.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM blocks notification_sender_block
        WHERE notification_sender_block.account_id = ${accountAlias}.id
          AND notification_sender_block.target_account_id = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM user_domain_blocks notification_domain_block
        WHERE notification_domain_block.account_id = ?
          AND ${accountAlias}.domain IS NOT NULL
          AND lower(notification_domain_block.domain) = lower(${accountAlias}.domain)
      )
    )`,
    bindings: [
      recipientAccountId,
      recipientAccountId,
      recipientAccountId,
      now,
      recipientAccountId,
      recipientAccountId,
      recipientAccountId,
    ],
  };
}

/** Applies canonical status visibility, surface suppression, and thread mutes. */
export function buildNotificationStatusSqlPredicate(
  source: StatusPermissionSqlSource,
  recipientAccountId: string,
  now: string,
): PermissionSqlPredicate {
  const statusAlias = resolveStatusPermissionSqlAlias(source);
  if (recipientAccountId.length === 0) {
    return { sql: '(1 = 0)', bindings: [] };
  }

  const visibility = buildStatusVisibilitySqlPredicate(source, recipientAccountId);
  const authorPermission = buildNotificationRelationshipSqlPredicate(
    'notification_status_author',
    recipientAccountId,
    now,
  );
  return {
    sql: `(
      ${visibility.sql}
      AND EXISTS (
        SELECT 1 FROM accounts notification_status_author
        WHERE notification_status_author.id = ${statusAlias}.account_id
          AND ${authorPermission.sql}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM status_mutes notification_status_mute
        JOIN statuses notification_muted_status
          ON notification_muted_status.id = notification_status_mute.status_id
        WHERE notification_status_mute.account_id = ?
          AND (
            notification_status_mute.status_id = ${statusAlias}.id
            OR (
              ${statusAlias}.conversation_id IS NOT NULL
              AND notification_muted_status.conversation_id = ${statusAlias}.conversation_id
            )
          )
      )
    )`,
    bindings: [
      ...visibility.bindings,
      ...authorPermission.bindings,
      recipientAccountId,
    ],
  };
}

export function canViewAccountRecord(account: AccountPermissionRecord): boolean {
  return canViewAccount({
    accountSuspended: account.suspended_at !== null,
  });
}

export async function canViewAccountById(accountId: string): Promise<boolean> {
  if (accountId.length === 0) return false;
  const account = await env.DB.prepare(
    `SELECT a.id, a.domain, a.suspended_at,
            u.approved AS user_approved,
            u.registration_state
     FROM accounts a
     LEFT JOIN users u ON u.account_id = a.id
     WHERE a.id = ?1
     LIMIT 1`,
  ).bind(accountId).first<AccountPermissionRecord & {
    user_approved: number | null;
    registration_state: string | null;
  }>();
  if (!account || !canViewAccountRecord(account)) return false;
  if (account.domain !== null) return true;
  return account.user_approved === 1 && account.registration_state === 'active';
}

export async function assertAccountViewable(accountId: string): Promise<void> {
  if (!await canViewAccountById(accountId)) {
    throw new AppError(404, 'Record not found');
  }
}

/** Validates the actor and target before creating a block or mute. */
export async function assertAccountRelationshipMutable(
  actorAccountId: string,
  targetAccountId: string,
): Promise<void> {
  if (actorAccountId === targetAccountId) {
    throw new AppError(422, 'Validation failed', 'You cannot target yourself');
  }

  const [actor, target] = await Promise.all([
    env.DB.prepare(
      `SELECT a.suspended_at, a.memorial,
              u.disabled AS user_disabled, u.approved AS user_approved
       FROM accounts a
       JOIN users u ON u.account_id = a.id
       WHERE a.id = ?
       LIMIT 1`,
    ).bind(actorAccountId).first<{
      suspended_at: string | null;
      memorial: number | null;
      user_disabled: number | null;
      user_approved: number | null;
    }>(),
    env.DB.prepare(
      'SELECT id, domain, suspended_at FROM accounts WHERE id = ? LIMIT 1',
    ).bind(targetAccountId).first<AccountPermissionRecord>(),
  ]);

  if (!target) {
    throw new AppError(404, 'Record not found');
  }
  const actorOperational = actor !== null && canOriginateAccountActivity({
    accountSuspended: actor.suspended_at !== null,
    accountMemorial: actor.memorial !== 0,
    isLocalAccount: true,
    userDisabled: actor.user_disabled !== 0,
    userApproved: actor.user_approved === 1,
  });
  if (!canCreateBlockOrMuteAccountRelationship({
    actorAccountId,
    targetAccountId,
    actorOperational,
    targetExists: true,
  })) {
    throw new AppError(403, 'This action is not allowed');
  }
}

/**
 * Remote discovery is denied for the local instance, globally suspended
 * domains, and domains explicitly blocked by the requesting account.
 */
export async function canResolveRemoteDomain(
  accountId: string | null,
  domain: string | null,
): Promise<boolean> {
  const normalizedDomain = domain?.trim().toLowerCase() ?? '';
  if (
    normalizedDomain.length === 0
    || normalizedDomain === env.INSTANCE_DOMAIN.toLowerCase()
  ) {
    return false;
  }
  const suspendedDomains = await getSuspendedDomains(env.DB, [normalizedDomain]);
  if (suspendedDomains.has(normalizedDomain)) return false;
  if (!accountId) return true;

  const userBlock = await env.DB.prepare(
    `SELECT 1 FROM user_domain_blocks
     WHERE account_id = ?
       AND lower(domain) = ?
     LIMIT 1`,
  ).bind(accountId, normalizedDomain).first();
  return userBlock === null;
}

export async function canViewAccountCollectionById(
  ownerAccountId: string,
  viewerAccountId: string | null,
): Promise<boolean> {
  if (ownerAccountId.length === 0) return false;
  const owner = await env.DB.prepare(
    `SELECT id, hide_collections
     FROM accounts
     WHERE id = ?1
     LIMIT 1`,
  ).bind(ownerAccountId).first<AccountCollectionPermissionRecord>();
  if (!owner) return false;
  return canViewAccountCollection({
    ownerAccountId: owner.id,
    viewerAccountId,
    collectionsHidden: owner.hide_collections === null
      ? null
      : owner.hide_collections === 1,
  });
}

export async function canSurfaceAccountToViewer(
  accountId: string,
  viewerAccountId: string | null,
): Promise<boolean> {
  if (accountId.length === 0) return false;
  const permission = buildAccountDiscoverySqlPredicate(
    'account',
    viewerAccountId,
    new Date().toISOString(),
  );
  const account = await env.DB.prepare(
    `SELECT a.id FROM accounts a
     WHERE a.id = ?
       AND ${permission.sql}
     LIMIT 1`,
  ).bind(accountId, ...permission.bindings).first<{ id: string }>();
  return account !== null;
}

export async function assertAccountSurfaceable(
  accountId: string,
  viewerAccountId: string | null,
): Promise<void> {
  if (!await canSurfaceAccountToViewer(accountId, viewerAccountId)) {
    throw new AppError(404, 'Record not found');
  }
}

/**
 * Validates the target-side boundary for a new follow. Existing relationships
 * can still be removed while the target is unavailable, so this is used only
 * by follow creation.
 */
export async function assertAccountFollowable(
  actorAccountId: string,
  targetAccountId: string,
): Promise<void> {
  if (actorAccountId === targetAccountId) {
    throw new AppError(422, 'Validation failed', 'You cannot follow yourself');
  }

  const target = await env.DB.prepare(
    `SELECT a.id, a.domain, a.suspended_at, a.memorial,
            a.moved_to_account_id,
            u.approved AS user_approved
     FROM accounts a
     LEFT JOIN users u ON u.account_id = a.id
     WHERE a.id = ?1
     LIMIT 1`,
  ).bind(targetAccountId).first<AccountPermissionRecord & {
    memorial: number | null;
    moved_to_account_id: string | null;
    user_approved: number | null;
  }>();
  const targetViewable = target !== null
    && canViewAccountRecord(target)
    && (target.domain !== null || target.user_approved === 1);
  if (!targetViewable) {
    throw new AppError(404, 'Record not found');
  }

  const [actorBlock, actorDomainBlock, targetBlock] = await Promise.all([
    env.DB.prepare(
      `SELECT 1 FROM blocks
       WHERE account_id = ?1 AND target_account_id = ?2
       LIMIT 1`,
    ).bind(actorAccountId, targetAccountId).first(),
    env.DB.prepare(
      `SELECT 1 FROM user_domain_blocks
       WHERE account_id = ?1
         AND ?2 IS NOT NULL
         AND lower(domain) = lower(?2)
       LIMIT 1`,
    ).bind(actorAccountId, target.domain).first(),
    env.DB.prepare(
      `SELECT 1 FROM blocks
       WHERE account_id = ?1 AND target_account_id = ?2
       LIMIT 1`,
    ).bind(targetAccountId, actorAccountId).first(),
  ]);

  if (!canFollowAccount({
    actorAccountId,
    targetAccountId,
    targetViewable,
    targetMemorial: target?.memorial === null || target?.memorial === undefined
      ? null
      : target.memorial !== 0,
    targetMoved: target === null ? null : target.moved_to_account_id !== null,
    actorBlocksTarget: actorBlock !== null,
    actorBlocksTargetDomain: actorDomainBlock !== null,
    targetBlocksActor: targetBlock !== null,
  })) {
    throw new AppError(403, 'This action is not allowed');
  }
}

function accountOperationalFacts(record: AccountOperationalPermissionFields) {
  return {
    accountSuspended: record.suspended_at !== null,
    accountMemorial: record.memorial === null ? null : record.memorial !== 0,
    isLocalAccount: record.domain === null,
    userDisabled: record.user_disabled === null ? null : record.user_disabled !== 0,
    userApproved: record.user_approved === null ? null : record.user_approved !== 0,
  };
}

export async function assertFollowRequestActionable(
  requesterAccountId: string,
  targetAccountId: string,
): Promise<FollowRequestRow> {
  const request = await env.DB.prepare(
    `SELECT fr.*,
            requester.domain,
            requester.suspended_at,
            requester.memorial,
            requester_user.disabled AS user_disabled,
            requester_user.approved AS user_approved,
            EXISTS (
              SELECT 1 FROM blocks requester_block
              WHERE requester_block.account_id = fr.account_id
                AND requester_block.target_account_id = fr.target_account_id
            ) AS requester_blocks_target,
            EXISTS (
              SELECT 1 FROM blocks target_block
              WHERE target_block.account_id = fr.target_account_id
                AND target_block.target_account_id = fr.account_id
            ) AS target_blocks_requester,
            EXISTS (
              SELECT 1 FROM user_domain_blocks target_domain_block
              WHERE target_domain_block.account_id = fr.target_account_id
                AND requester.domain IS NOT NULL
                AND lower(target_domain_block.domain) = lower(requester.domain)
            ) AS target_blocks_requester_domain
     FROM follow_requests fr
     JOIN accounts requester ON requester.id = fr.account_id
     LEFT JOIN users requester_user ON requester_user.account_id = requester.id
     WHERE fr.account_id = ?1 AND fr.target_account_id = ?2
     LIMIT 1`,
  ).bind(requesterAccountId, targetAccountId).first<FollowRequestActionPermissionRecord>();

  if (!request) throw new AppError(404, 'Record not found');
  if (!canProcessFollowRequest({
    requesterAccountId: request.account_id,
    targetAccountId: request.target_account_id,
    requesterOperational: accountOperationalFacts(request),
    requesterBlocksTarget: request.requester_blocks_target !== 0,
    targetBlocksRequester: request.target_blocks_requester !== 0,
    targetBlocksRequesterDomain:
      request.target_blocks_requester_domain !== 0,
  })) {
    throw new AppError(403, 'This action is not allowed');
  }
  return request;
}

/**
 * Fixed-alias projection of canProcessFollowRequest for pending-request lists.
 * The caller must join accounts as `a`, users as `requester_user`, and requests
 * as `fr`; request-controlled identifiers remain bindings in the outer query.
 */
export function buildActionableFollowRequestSqlPredicate(): PermissionSqlPredicate {
  return {
    sql: `(
      fr.account_id != fr.target_account_id
      AND a.suspended_at IS NULL
      AND COALESCE(a.memorial, 0) = 0
      AND (
        a.domain IS NOT NULL
        OR (requester_user.disabled = 0 AND requester_user.approved = 1)
      )
      AND NOT EXISTS (
        SELECT 1 FROM blocks requester_block
        WHERE requester_block.account_id = fr.account_id
          AND requester_block.target_account_id = fr.target_account_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM blocks target_block
        WHERE target_block.account_id = fr.target_account_id
          AND target_block.target_account_id = fr.account_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM user_domain_blocks target_domain_block
        WHERE target_domain_block.account_id = fr.target_account_id
          AND a.domain IS NOT NULL
          AND lower(target_domain_block.domain) = lower(a.domain)
      )
    )`,
    bindings: [],
  };
}

export async function canReceiveIncomingFollow(
  requesterAccountId: string,
  targetAccountId: string,
  recipientAccountId: string | null,
): Promise<boolean> {
  if (requesterAccountId.length === 0 || targetAccountId.length === 0) {
    return false;
  }

  const row = await env.DB.prepare(
    `SELECT requester.domain AS requester_domain,
            requester.suspended_at AS requester_suspended_at,
            requester.memorial AS requester_memorial,
            requester_user.disabled AS requester_user_disabled,
            requester_user.approved AS requester_user_approved,
            target.domain AS target_domain,
            target.suspended_at AS target_suspended_at,
            target.memorial AS target_memorial,
            target.moved_to_account_id AS target_moved_to_account_id,
            target_user.disabled AS target_user_disabled,
            target_user.approved AS target_user_approved,
            EXISTS (
              SELECT 1 FROM blocks requester_block
              WHERE requester_block.account_id = requester.id
                AND requester_block.target_account_id = target.id
            ) AS requester_blocks_target,
            EXISTS (
              SELECT 1 FROM blocks target_block
              WHERE target_block.account_id = target.id
                AND target_block.target_account_id = requester.id
            ) AS target_blocks_requester,
            EXISTS (
              SELECT 1 FROM user_domain_blocks target_domain_block
              WHERE target_domain_block.account_id = target.id
                AND requester.domain IS NOT NULL
                AND lower(target_domain_block.domain) = lower(requester.domain)
            ) AS target_blocks_requester_domain
     FROM accounts requester
     JOIN accounts target ON target.id = ?2
     LEFT JOIN users requester_user ON requester_user.account_id = requester.id
     LEFT JOIN users target_user ON target_user.account_id = target.id
     WHERE requester.id = ?1
     LIMIT 1`,
  ).bind(requesterAccountId, targetAccountId).first<{
    requester_domain: string | null;
    requester_suspended_at: string | null;
    requester_memorial: number | null;
    requester_user_disabled: number | null;
    requester_user_approved: number | null;
    target_domain: string | null;
    target_suspended_at: string | null;
    target_memorial: number | null;
    target_moved_to_account_id: string | null;
    target_user_disabled: number | null;
    target_user_approved: number | null;
    requester_blocks_target: number;
    target_blocks_requester: number;
    target_blocks_requester_domain: number;
  }>();
  if (!row) return false;

  return canReceiveFederatedFollow({
    requesterAccountId,
    targetAccountId,
    recipientAccountId,
    requesterIsRemote: row.requester_domain !== null,
    targetIsLocal: row.target_domain === null,
    targetMoved: row.target_moved_to_account_id !== null,
    requesterOperational: {
      accountSuspended: row.requester_suspended_at !== null,
      accountMemorial: row.requester_memorial === null
        ? null
        : row.requester_memorial !== 0,
      isLocalAccount: row.requester_domain === null,
      userDisabled: row.requester_user_disabled === null
        ? null
        : row.requester_user_disabled !== 0,
      userApproved: row.requester_user_approved === null
        ? null
        : row.requester_user_approved !== 0,
    },
    targetOperational: {
      accountSuspended: row.target_suspended_at !== null,
      userDisabled: row.target_user_disabled === null
        ? null
        : row.target_user_disabled !== 0,
      userApproved: row.target_user_approved === null
        ? null
        : row.target_user_approved !== 0,
      memorial: row.target_memorial === null
        ? null
        : row.target_memorial !== 0,
    },
    requesterBlocksTarget: row.requester_blocks_target !== 0,
    targetBlocksRequester: row.target_blocks_requester !== 0,
    targetBlocksRequesterDomain: row.target_blocks_requester_domain !== 0,
  });
}

export async function canProcessIncomingAccountTarget(
  actorAccountId: string,
  targetAccountId: string,
  recipientAccountId: string | null,
): Promise<boolean> {
  if (actorAccountId.length === 0 || targetAccountId.length === 0) return false;

  const row = await env.DB.prepare(
    `SELECT actor.domain AS actor_domain,
            actor.suspended_at AS actor_suspended_at,
            actor.memorial AS actor_memorial,
            actor_user.disabled AS actor_user_disabled,
            actor_user.approved AS actor_user_approved,
            target.domain AS target_domain
     FROM accounts actor
     JOIN accounts target ON target.id = ?2
     LEFT JOIN users actor_user ON actor_user.account_id = actor.id
     WHERE actor.id = ?1
     LIMIT 1`,
  ).bind(actorAccountId, targetAccountId).first<{
    actor_domain: string | null;
    actor_suspended_at: string | null;
    actor_memorial: number | null;
    actor_user_disabled: number | null;
    actor_user_approved: number | null;
    target_domain: string | null;
  }>();
  if (!row) return false;

  return canProcessFederatedAccountTarget({
    actorAccountId,
    targetAccountId,
    recipientAccountId,
    actorOperational: {
      accountSuspended: row.actor_suspended_at !== null,
      accountMemorial: row.actor_memorial === null
        ? null
        : row.actor_memorial !== 0,
      isLocalAccount: row.actor_domain === null,
      userDisabled: row.actor_user_disabled === null
        ? null
        : row.actor_user_disabled !== 0,
      userApproved: row.actor_user_approved === null
        ? null
        : row.actor_user_approved !== 0,
    },
    actorIsRemote: row.actor_domain !== null,
    targetIsLocal: row.target_domain === null,
  });
}

export async function canUndoIncomingAccountTarget(
  actorAccountId: string,
  targetAccountId: string,
  recipientAccountId: string | null,
  embeddedActorMatches: boolean,
  storedTargetMatches: boolean,
): Promise<boolean> {
  if (actorAccountId.length === 0 || targetAccountId.length === 0) return false;

  const row = await env.DB.prepare(
    `SELECT actor.domain AS actor_domain,
            actor.suspended_at AS actor_suspended_at,
            actor.memorial AS actor_memorial,
            actor_user.disabled AS actor_user_disabled,
            actor_user.approved AS actor_user_approved,
            target.domain AS target_domain
     FROM accounts actor
     JOIN accounts target ON target.id = ?2
     LEFT JOIN users actor_user ON actor_user.account_id = actor.id
     WHERE actor.id = ?1
     LIMIT 1`,
  ).bind(actorAccountId, targetAccountId).first<{
    actor_domain: string | null;
    actor_suspended_at: string | null;
    actor_memorial: number | null;
    actor_user_disabled: number | null;
    actor_user_approved: number | null;
    target_domain: string | null;
  }>();
  if (!row) return false;

  return canUndoFederatedAccountAction({
    actorAccountId,
    targetAccountId,
    recipientAccountId,
    actorOperational: {
      accountSuspended: row.actor_suspended_at !== null,
      accountMemorial: row.actor_memorial === null
        ? null
        : row.actor_memorial !== 0,
      isLocalAccount: row.actor_domain === null,
      userDisabled: row.actor_user_disabled === null
        ? null
        : row.actor_user_disabled !== 0,
      userApproved: row.actor_user_approved === null
        ? null
        : row.actor_user_approved !== 0,
    },
    actorIsRemote: row.actor_domain !== null,
    targetIsLocal: row.target_domain === null,
    embeddedActorMatches,
    storedTargetMatches,
  });
}

export async function canProcessIncomingActorUpdate(
  actorAccountId: string,
  ownerAccountId: string,
): Promise<boolean> {
  if (actorAccountId.length === 0 || ownerAccountId.length === 0) return false;

  const actor = await env.DB.prepare(
    `SELECT a.domain, a.suspended_at, a.memorial,
            u.disabled AS user_disabled, u.approved AS user_approved
     FROM accounts a
     LEFT JOIN users u ON u.account_id = a.id
     WHERE a.id = ?1
     LIMIT 1`,
  ).bind(actorAccountId).first<{
    domain: string | null;
    suspended_at: string | null;
    memorial: number | null;
    user_disabled: number | null;
    user_approved: number | null;
  }>();
  if (!actor) return false;

  return canApplyFederatedActorUpdate({
    actorAccountId,
    ownerAccountId,
    actorIsRemote: actor.domain !== null,
    actorOperational: {
      accountSuspended: actor.suspended_at !== null,
      accountMemorial: actor.memorial === null ? null : actor.memorial !== 0,
      isLocalAccount: actor.domain === null,
      userDisabled: actor.user_disabled === null ? null : actor.user_disabled !== 0,
      userApproved: actor.user_approved === null ? null : actor.user_approved !== 0,
    },
  });
}

export async function canProcessIncomingOwnedDelete(
  actorAccountId: string,
  ownerAccountId: string,
): Promise<boolean> {
  if (actorAccountId.length === 0 || ownerAccountId.length === 0) return false;
  const actor = await env.DB.prepare(
    'SELECT domain FROM accounts WHERE id = ?1 LIMIT 1',
  ).bind(actorAccountId).first<{ domain: string | null }>();
  return actor !== null && canApplyFederatedDelete({
    actorAccountId,
    ownerAccountId,
    actorIsRemote: actor.domain !== null,
  });
}

export async function canProcessIncomingMove(
  actorAccountId: string,
  oldAccountId: string,
  newAccountId: string,
  recipientAccountId: string | null,
  newAccountAliasesOld: boolean,
): Promise<boolean> {
  if (
    actorAccountId.length === 0
    || oldAccountId.length === 0
    || newAccountId.length === 0
  ) return false;

  const row = await env.DB.prepare(
    `SELECT old_account.domain AS old_domain,
            old_account.suspended_at AS old_suspended_at,
            old_account.memorial AS old_memorial,
            old_account.moved_to_account_id AS old_moved_to_account_id,
            old_user.disabled AS old_user_disabled,
            old_user.approved AS old_user_approved,
            new_account.domain AS new_domain,
            new_account.suspended_at AS new_suspended_at,
            new_account.memorial AS new_memorial,
            new_account.moved_to_account_id AS new_moved_to_account_id,
            new_user.disabled AS new_user_disabled,
            new_user.approved AS new_user_approved,
            recipient.domain AS recipient_domain,
            recipient.suspended_at AS recipient_suspended_at,
            recipient.memorial AS recipient_memorial,
            recipient_user.disabled AS recipient_user_disabled,
            recipient_user.approved AS recipient_user_approved,
            EXISTS (
              SELECT 1 FROM follows recipient_follow
              WHERE recipient_follow.account_id = ?4
                AND recipient_follow.target_account_id = old_account.id
            ) AS recipient_follows_old
     FROM accounts old_account
     JOIN accounts new_account ON new_account.id = ?3
     LEFT JOIN users old_user ON old_user.account_id = old_account.id
     LEFT JOIN users new_user ON new_user.account_id = new_account.id
     LEFT JOIN accounts recipient ON recipient.id = ?4
     LEFT JOIN users recipient_user ON recipient_user.account_id = recipient.id
     WHERE old_account.id = ?2 AND old_account.id = ?1
     LIMIT 1`,
  ).bind(
    actorAccountId,
    oldAccountId,
    newAccountId,
    recipientAccountId,
  ).first<{
    old_domain: string | null;
    old_suspended_at: string | null;
    old_memorial: number | null;
    old_moved_to_account_id: string | null;
    old_user_disabled: number | null;
    old_user_approved: number | null;
    new_domain: string | null;
    new_suspended_at: string | null;
    new_memorial: number | null;
    new_moved_to_account_id: string | null;
    new_user_disabled: number | null;
    new_user_approved: number | null;
    recipient_domain: string | null;
    recipient_suspended_at: string | null;
    recipient_memorial: number | null;
    recipient_user_disabled: number | null;
    recipient_user_approved: number | null;
    recipient_follows_old: number;
  }>();
  if (!row) return false;

  const hasPersonalRecipient = recipientAccountId !== null;
  return canProcessFederatedMove({
    actorAccountId,
    oldAccountId,
    newAccountId,
    recipientAccountId,
    actorIsRemote: row.old_domain !== null,
    actorOperational: {
      accountSuspended: row.old_suspended_at !== null,
      accountMemorial: row.old_memorial === null ? null : row.old_memorial !== 0,
      isLocalAccount: row.old_domain === null,
      userDisabled: row.old_user_disabled === null ? null : row.old_user_disabled !== 0,
      userApproved: row.old_user_approved === null ? null : row.old_user_approved !== 0,
    },
    newAccountOperational: {
      accountSuspended: row.new_suspended_at !== null,
      accountMemorial: row.new_memorial === null ? null : row.new_memorial !== 0,
      isLocalAccount: row.new_domain === null,
      userDisabled: row.new_user_disabled === null ? null : row.new_user_disabled !== 0,
      userApproved: row.new_user_approved === null ? null : row.new_user_approved !== 0,
    },
    newAccountMoved: row.new_moved_to_account_id !== null,
    newAccountAliasesOld,
    oldMovedToAccountId: row.old_moved_to_account_id,
    recipientIsLocal: hasPersonalRecipient ? row.recipient_domain === null : null,
    recipientFollowsOld: hasPersonalRecipient ? row.recipient_follows_old !== 0 : null,
    recipientOperational: hasPersonalRecipient ? {
      accountSuspended: row.recipient_suspended_at !== null,
      userDisabled: row.recipient_user_disabled === null
        ? null
        : row.recipient_user_disabled !== 0,
      userApproved: row.recipient_user_approved === null
        ? null
        : row.recipient_user_approved !== 0,
      memorial: row.recipient_memorial === null ? null : row.recipient_memorial !== 0,
    } : null,
  });
}

export interface FederatedMoveRefollowCandidate {
  accountId: string;
  uri: string;
  username: string;
}

export async function getFederatedMoveRefollowCandidates(
  oldAccountId: string,
  newAccountId: string,
): Promise<FederatedMoveRefollowCandidate[]> {
  if (oldAccountId.length === 0 || newAccountId.length === 0) return [];

  const { results } = await env.DB.prepare(
    `SELECT follower.id AS account_id,
            follower.uri,
            follower.username,
            follower.domain,
            follower.suspended_at,
            follower.memorial,
            follower_user.disabled AS user_disabled,
            follower_user.approved AS user_approved,
            EXISTS (
              SELECT 1 FROM follows new_follow
              WHERE new_follow.account_id = follower.id
                AND new_follow.target_account_id = ?2
            ) AS already_follows_new,
            EXISTS (
              SELECT 1 FROM follow_requests new_request
              WHERE new_request.account_id = follower.id
                AND new_request.target_account_id = ?2
            ) AS already_requested_new,
            EXISTS (
              SELECT 1 FROM blocks follower_block
              WHERE follower_block.account_id = follower.id
                AND follower_block.target_account_id = ?2
            ) AS follower_blocks_new,
            EXISTS (
              SELECT 1 FROM blocks new_block
              WHERE new_block.account_id = ?2
                AND new_block.target_account_id = follower.id
            ) AS new_blocks_follower,
            EXISTS (
              SELECT 1 FROM user_domain_blocks domain_block
              JOIN accounts new_account ON new_account.id = ?2
              WHERE domain_block.account_id = follower.id
                AND new_account.domain IS NOT NULL
                AND lower(domain_block.domain) = lower(new_account.domain)
            ) AS follower_blocks_new_domain
     FROM follows old_follow
     JOIN accounts follower ON follower.id = old_follow.account_id
     LEFT JOIN users follower_user ON follower_user.account_id = follower.id
     WHERE old_follow.target_account_id = ?1
       AND follower.domain IS NULL`,
  ).bind(oldAccountId, newAccountId).all<{
    account_id: string;
    uri: string;
    username: string;
    domain: string | null;
    suspended_at: string | null;
    memorial: number | null;
    user_disabled: number | null;
    user_approved: number | null;
    already_follows_new: number;
    already_requested_new: number;
    follower_blocks_new: number;
    new_blocks_follower: number;
    follower_blocks_new_domain: number;
  }>();

  return (results ?? []).filter((candidate) => canRefollowAfterFederatedMove({
    followerAccountId: candidate.account_id,
    oldAccountId,
    newAccountId,
    followerOperational: {
      accountSuspended: candidate.suspended_at !== null,
      accountMemorial: candidate.memorial === null ? null : candidate.memorial !== 0,
      isLocalAccount: candidate.domain === null,
      userDisabled: candidate.user_disabled === null ? null : candidate.user_disabled !== 0,
      userApproved: candidate.user_approved === null ? null : candidate.user_approved !== 0,
    },
    followsOld: true,
    alreadyFollowsNew: candidate.already_follows_new !== 0,
    alreadyRequestedNew: candidate.already_requested_new !== 0,
    followerBlocksNew: candidate.follower_blocks_new !== 0,
    followerBlocksNewDomain: candidate.follower_blocks_new_domain !== 0,
    newBlocksFollower: candidate.new_blocks_follower !== 0,
  })).map((candidate) => ({
    accountId: candidate.account_id,
    uri: candidate.uri,
    username: candidate.username,
  }));
}

export async function assertListMemberAddable(
  listId: string,
  actorAccountId: string,
  memberAccountId: string,
): Promise<string> {
  const member = await env.DB.prepare(
    `SELECT l.account_id AS list_owner_account_id,
            candidate.id AS member_account_id,
            candidate.domain,
            candidate.suspended_at,
            candidate.memorial,
            candidate_user.disabled AS user_disabled,
            candidate_user.approved AS user_approved,
            owner_follow.id AS follow_id,
            EXISTS (
              SELECT 1 FROM blocks owner_block
              WHERE owner_block.account_id = ?2
                AND owner_block.target_account_id = candidate.id
            ) AS actor_blocks_member,
            EXISTS (
              SELECT 1 FROM blocks candidate_block
              WHERE candidate_block.account_id = candidate.id
                AND candidate_block.target_account_id = ?2
            ) AS member_blocks_actor
     FROM lists l
     JOIN accounts candidate ON candidate.id = ?3
     LEFT JOIN users candidate_user ON candidate_user.account_id = candidate.id
     LEFT JOIN follows owner_follow
       ON owner_follow.account_id = ?2
      AND owner_follow.target_account_id = candidate.id
     WHERE l.id = ?1
     LIMIT 1`,
  ).bind(listId, actorAccountId, memberAccountId).first<ListMemberPermissionRecord>();

  if (!member || member.list_owner_account_id !== actorAccountId) {
    throw new AppError(404, 'Record not found');
  }
  if (!canAddAccountToList({
    actorAccountId,
    listOwnerAccountId: member.list_owner_account_id,
    memberAccountId: member.member_account_id,
    memberOperational: accountOperationalFacts(member),
    actorFollowsMember: member.follow_id !== null,
    actorBlocksMember: member.actor_blocks_member !== 0,
    memberBlocksActor: member.member_blocks_actor !== 0,
  }) || member.follow_id === null) {
    throw new AppError(422, 'Validation failed', 'Only active followed accounts can be added to a list');
  }
  return member.follow_id;
}

export async function listPermittedListMemberIds(
  listId: string,
  actorAccountId: string,
): Promise<string[]> {
  const list = await env.DB.prepare(
    'SELECT account_id FROM lists WHERE id = ?1 LIMIT 1',
  ).bind(listId).first<{ account_id: string }>();
  if (!list || list.account_id !== actorAccountId) {
    throw new AppError(404, 'Record not found');
  }

  const members = await env.DB.prepare(
    `SELECT l.account_id AS list_owner_account_id,
            candidate.id AS member_account_id,
            candidate.domain,
            candidate.suspended_at,
            candidate.memorial,
            candidate_user.disabled AS user_disabled,
            candidate_user.approved AS user_approved,
            owner_follow.id AS follow_id,
            EXISTS (
              SELECT 1 FROM blocks owner_block
              WHERE owner_block.account_id = ?2
                AND owner_block.target_account_id = candidate.id
            ) AS actor_blocks_member,
            EXISTS (
              SELECT 1 FROM blocks candidate_block
              WHERE candidate_block.account_id = candidate.id
                AND candidate_block.target_account_id = ?2
            ) AS member_blocks_actor
     FROM lists l
     JOIN list_accounts list_member ON list_member.list_id = l.id
     JOIN accounts candidate ON candidate.id = list_member.account_id
     LEFT JOIN users candidate_user ON candidate_user.account_id = candidate.id
     LEFT JOIN follows owner_follow
       ON owner_follow.account_id = ?2
      AND owner_follow.target_account_id = candidate.id
     WHERE l.id = ?1`,
  ).bind(listId, actorAccountId).all<ListMemberPermissionRecord>();

  return members.results
    .filter((member) => canAddAccountToList({
      actorAccountId,
      listOwnerAccountId: member.list_owner_account_id,
      memberAccountId: member.member_account_id,
      memberOperational: accountOperationalFacts(member),
      actorFollowsMember: member.follow_id !== null,
      actorBlocksMember: member.actor_blocks_member !== 0,
      memberBlocksActor: member.member_blocks_actor !== 0,
    }))
    .map((member) => member.member_account_id);
}

export async function assertAccountFeatureable(
  actorAccountId: string,
  targetAccountId: string,
): Promise<void> {
  const target = await env.DB.prepare(
    'SELECT id, domain, suspended_at FROM accounts WHERE id = ?1 LIMIT 1',
  ).bind(targetAccountId).first<AccountPermissionRecord>();
  if (!target) throw new AppError(404, 'Record not found');

  const follow = await env.DB.prepare(
    `SELECT 1 FROM follows
     WHERE account_id = ?1 AND target_account_id = ?2
     LIMIT 1`,
  ).bind(actorAccountId, targetAccountId).first();
  if (!canFeatureAccount({
    actorAccountId,
    targetAccountId,
    targetViewable: canViewAccountRecord(target),
    actorFollowsTarget: follow !== null,
  })) {
    throw new AppError(422, 'Validation failed: you must be following this account to endorse it');
  }
}

export async function canViewStatusRecord(
  status: StatusPermissionRecord,
  viewerAccountId: string | null,
): Promise<boolean> {
  const author = status.account_id
    ? await env.DB.prepare(
      'SELECT suspended_at FROM accounts WHERE id = ?1 LIMIT 1',
    ).bind(status.account_id).first<{ suspended_at: string | null }>()
    : null;
  if (!author || author.suspended_at !== null) return false;

  const visibility = parseStatusVisibility(status.visibility);
  if (!visibility) return false;

  let viewerFollowsAuthor = false;
  let viewerIsMentioned = false;
  let authorBlocksViewer = false;

  if (viewerAccountId && viewerAccountId !== status.account_id) {
    if (visibility === 'private' && status.account_id) {
      const [follow, mention] = await Promise.all([
        env.DB.prepare(
          'SELECT 1 FROM follows WHERE account_id = ?1 AND target_account_id = ?2 LIMIT 1',
        ).bind(viewerAccountId, status.account_id).first(),
        env.DB.prepare(
          'SELECT 1 FROM mentions WHERE status_id = ?1 AND account_id = ?2 LIMIT 1',
        ).bind(status.id, viewerAccountId).first(),
      ]);
      viewerFollowsAuthor = follow !== null;
      viewerIsMentioned = mention !== null;
    } else if (visibility === 'direct') {
      const mention = await env.DB.prepare(
        'SELECT 1 FROM mentions WHERE status_id = ?1 AND account_id = ?2 LIMIT 1',
      ).bind(status.id, viewerAccountId).first();
      viewerIsMentioned = mention !== null;
    } else {
      const block = await env.DB.prepare(
        `SELECT 1 FROM blocks
         WHERE account_id = ?1 AND target_account_id = ?2
         LIMIT 1`,
      ).bind(status.account_id, viewerAccountId).first();
      authorBlocksViewer = block !== null;
    }
  }

  return canViewStatus({
    visibility,
    viewerAccountId,
    authorAccountId: status.account_id,
    viewerFollowsAuthor,
    viewerIsMentioned,
    authorBlocksViewer,
    statusDeleted: status.deleted_at !== null,
  });
}

export async function canViewStatusById(
  statusId: string,
  viewerAccountId: string | null,
): Promise<boolean> {
  const status = await env.DB.prepare(
    'SELECT id, account_id, visibility, deleted_at FROM statuses WHERE id = ?1 LIMIT 1',
  ).bind(statusId).first<StatusPermissionRecord>();
  return status ? canViewStatusRecord(status, viewerAccountId) : false;
}

export async function assertStatusViewable(
  statusId: string,
  viewerAccountId: string | null,
): Promise<void> {
  if (!await canViewStatusById(statusId, viewerAccountId)) {
    throw new AppError(404, 'Record not found');
  }
}

/** Requires both canonical visibility and an unblocked interaction direction. */
export async function assertStatusInteractable(
  statusId: string,
  actorAccountId: string,
): Promise<void> {
  if (!await canAccountInteractWithStatus(statusId, actorAccountId)) {
    throw new AppError(404, 'Record not found');
  }
}

export async function canSurfaceStatusToViewer(
  statusId: string,
  viewerAccountId: string | null,
): Promise<boolean> {
  if (statusId.length === 0 || viewerAccountId === '') return false;

  const visibility = buildStatusVisibilitySqlPredicate('status', viewerAccountId);
  const relationship = buildStatusRelationshipSqlPredicate(
    'status',
    viewerAccountId,
    new Date().toISOString(),
  );
  const status = await env.DB.prepare(
    `SELECT s.id FROM statuses s
     WHERE s.id = ?
       AND ${visibility.sql}
       AND ${relationship.sql}
     LIMIT 1`,
  ).bind(
    statusId,
    ...visibility.bindings,
    ...relationship.bindings,
  ).first<{ id: string }>();
  return status !== null;
}

export async function canAccountInteractWithStatus(
  statusId: string,
  actorAccountId: string,
): Promise<boolean> {
  if (statusId.length === 0 || actorAccountId.length === 0) return false;

  const [actorOperational, status] = await Promise.all([
    canAccountOriginateFederationActivity(actorAccountId),
    env.DB.prepare(
      `SELECT s.id, s.account_id, s.visibility, s.deleted_at,
              author.domain AS author_domain
       FROM statuses s
       JOIN accounts author ON author.id = s.account_id
       WHERE s.id = ?1
       LIMIT 1`,
    ).bind(statusId).first<StatusPermissionRecord & { author_domain: string | null }>(),
  ]);
  const statusViewable = actorOperational && status !== null
    ? await canViewStatusRecord(status, actorAccountId)
    : false;
  const [actorBlock, actorDomainBlock] = status?.account_id
    && status.account_id !== actorAccountId
    ? await Promise.all([
      env.DB.prepare(
        `SELECT 1 FROM blocks
         WHERE account_id = ?1 AND target_account_id = ?2
         LIMIT 1`,
      ).bind(actorAccountId, status.account_id).first(),
      env.DB.prepare(
        `SELECT 1 FROM user_domain_blocks
         WHERE account_id = ?1
           AND ?2 IS NOT NULL
           AND lower(domain) = lower(?2)
         LIMIT 1`,
      ).bind(actorAccountId, status.author_domain).first(),
    ])
    : [null, null];
  return canInteractWithStatus({
    statusViewable,
    actorSuspended: actorOperational ? false : null,
    actorBlocksAuthor: status?.account_id === actorAccountId
      ? false
      : actorBlock !== null,
    actorBlocksAuthorDomain: status?.account_id === actorAccountId
      ? false
      : actorDomainBlock !== null,
  });
}

export async function canAccountOriginateFederationActivity(
  actorAccountId: string,
): Promise<boolean> {
  if (actorAccountId.length === 0) return false;

  const actor = await env.DB.prepare(
    `SELECT a.suspended_at, a.memorial, a.domain,
            u.disabled AS user_disabled, u.approved AS user_approved
     FROM accounts a
     LEFT JOIN users u ON u.account_id = a.id
     WHERE a.id = ?1
     LIMIT 1`,
  ).bind(actorAccountId).first<{
    suspended_at: string | null;
    memorial: number | null;
    domain: string | null;
    user_disabled: number | null;
    user_approved: number | null;
  }>();

  return canOriginateAccountActivity({
    accountSuspended: actor ? actor.suspended_at !== null : null,
    accountMemorial: actor?.memorial === null || actor?.memorial === undefined
      ? null
      : actor.memorial !== 0,
    isLocalAccount: actor ? actor.domain === null : null,
    userDisabled: actor?.user_disabled === null || actor?.user_disabled === undefined
      ? null
      : actor.user_disabled !== 0,
    userApproved: actor?.user_approved === null || actor?.user_approved === undefined
      ? null
      : actor.user_approved !== 0,
  });
}

/** Current D1 authority for publishing any child resource of a local Actor. */
export async function canExposeLocalAccountActivityPubResources(
  accountId: string,
): Promise<boolean> {
  return accountId.length > 0
    && await canAccountOriginateFederationActivity(accountId);
}

export async function canExposeLocalAccountActivityPubResourcesByUsername(
  username: string,
): Promise<boolean> {
  if (username.length === 0) return false;
  const account = await env.DB.prepare(
    `SELECT id FROM accounts
     WHERE username = ?1 AND domain IS NULL
     LIMIT 1`,
  ).bind(username).first<{ id: string }>();
  return account !== null
    && await canExposeLocalAccountActivityPubResources(account.id);
}

export function canExposeActivityPubPublicStatusRecord(
  status: Pick<StatusPermissionRecord, 'visibility' | 'deleted_at'>,
  authorAvailable: boolean,
): boolean {
  return canExposeStatusInActivityPubPublicCollection({
    visibility: status.visibility,
    statusDeleted: status.deleted_at !== null,
    authorAvailable,
  });
}

export interface FederatedReportAuthorization {
  statusIds: string[];
}

/**
 * Resolves and authorizes every stateful input to a remote Flag. Returning
 * null is deliberately fail-closed; callers must not retain a partial list of
 * valid status references when any supplied URI is invalid.
 */
export async function authorizeFederatedReport(
  reporterAccountId: string,
  targetAccountId: string,
  recipientAccountId: string | null,
  statusUris: readonly string[],
): Promise<FederatedReportAuthorization | null> {
  if (reporterAccountId.length === 0 || targetAccountId.length === 0) return null;

  const [reporter, target] = await Promise.all([
    env.DB.prepare(
      `SELECT a.domain, a.suspended_at, a.memorial,
              u.disabled AS user_disabled, u.approved AS user_approved
       FROM accounts a
       LEFT JOIN users u ON u.account_id = a.id
       WHERE a.id = ?1
       LIMIT 1`,
    ).bind(reporterAccountId).first<AccountOperationalPermissionFields>(),
    env.DB.prepare(
      `SELECT a.domain, a.suspended_at, a.memorial,
              u.disabled AS user_disabled, u.approved AS user_approved
       FROM accounts a
       LEFT JOIN users u ON u.account_id = a.id
       WHERE a.id = ?1
       LIMIT 1`,
    ).bind(targetAccountId).first<AccountOperationalPermissionFields>(),
  ]);
  if (!reporter || !target) return null;

  const uniqueStatusUris = [...new Set(statusUris)];
  const statusIds: string[] = [];
  let allStatusReferencesAuthorized = true;
  for (const statusUri of uniqueStatusUris) {
    if (statusUri.length === 0) {
      allStatusReferencesAuthorized = false;
      break;
    }
    const status = await env.DB.prepare(
      `SELECT id, account_id, visibility, deleted_at
       FROM statuses
       WHERE uri = ?1
       LIMIT 1`,
    ).bind(statusUri).first<StatusPermissionRecord>();
    if (
      !status
      || status.account_id !== targetAccountId
      || !await canViewStatusRecord(status, reporterAccountId)
    ) {
      allStatusReferencesAuthorized = false;
      break;
    }
    statusIds.push(status.id);
  }

  const allowed = canAcceptFederatedReport({
    reporterAccountId,
    targetAccountId,
    recipientAccountId,
    reporterOperational: canOriginateAccountActivity(accountOperationalFacts(reporter)),
    reporterIsRemote: reporter.domain !== null,
    targetOperational: canOriginateAccountActivity(accountOperationalFacts(target)),
    targetIsLocal: target.domain === null,
    allStatusReferencesAuthorized,
  });
  return allowed ? { statusIds } : null;
}

/**
 * Restricts an inbound status interaction to a local status and, for a
 * personal inbox, to the exact inbox owner. The shared inbox passes null.
 */
export async function canProcessFederatedStatusInteraction(
  statusId: string,
  actorAccountId: string,
  recipientAccountId: string | null,
): Promise<boolean> {
  if (statusId.length === 0 || actorAccountId.length === 0) return false;

  const target = await env.DB.prepare(
    `SELECT s.account_id, a.domain
     FROM statuses s
     JOIN accounts a ON a.id = s.account_id
     WHERE s.id = ?1
     LIMIT 1`,
  ).bind(statusId).first<{ account_id: string; domain: string | null }>();
  if (!target || target.domain !== null) return false;
  if (recipientAccountId && target.account_id !== recipientAccountId) return false;

  const actor = await env.DB.prepare(
    'SELECT domain FROM accounts WHERE id = ?1 LIMIT 1',
  ).bind(actorAccountId).first<{ domain: string | null }>();
  if (!actor) return false;
  const [targetBlocksActor, targetBlocksActorDomain] = await Promise.all([
    env.DB.prepare(
      `SELECT 1 FROM blocks
       WHERE account_id = ?1 AND target_account_id = ?2
       LIMIT 1`,
    ).bind(target.account_id, actorAccountId).first(),
    actor.domain === null
      ? Promise.resolve(null)
      : env.DB.prepare(
        `SELECT 1 FROM user_domain_blocks
         WHERE account_id = ?1
           AND lower(domain) = lower(?2)
         LIMIT 1`,
      ).bind(target.account_id, actor.domain).first(),
  ]);
  if (targetBlocksActor !== null || targetBlocksActorDomain !== null) return false;

  return canAccountInteractWithStatus(statusId, actorAccountId);
}

export async function canQuoteStatusRecord(
  status: StatusQuotePermissionRecord,
  requesterAccountId: string,
): Promise<boolean> {
  if (requesterAccountId.length === 0 || !status.account_id) return false;

  const statusViewable = await canViewStatusRecord(status, requesterAccountId);
  const requesterIsAuthor = requesterAccountId === status.account_id;
  const identities = await env.DB.prepare(
    `SELECT author.uri AS author_uri, requester.uri AS requester_uri,
            EXISTS(
              SELECT 1 FROM follows
              WHERE account_id = requester.id AND target_account_id = author.id
            ) AS requester_follows_author,
            EXISTS(
              SELECT 1 FROM follows
              WHERE account_id = author.id AND target_account_id = requester.id
            ) AS author_follows_requester,
            EXISTS(
              SELECT 1 FROM blocks
              WHERE account_id = requester.id AND target_account_id = author.id
            ) AS requester_blocks_author,
            EXISTS(
              SELECT 1 FROM user_domain_blocks
              WHERE account_id = requester.id
                AND author.domain IS NOT NULL
                AND lower(domain) = lower(author.domain)
            ) AS requester_blocks_author_domain
     FROM accounts author
     JOIN accounts requester ON requester.id = ?1
     WHERE author.id = ?2
     LIMIT 1`,
  ).bind(requesterAccountId, status.account_id).first<{
    author_uri: string;
    requester_uri: string;
    requester_follows_author: number;
    author_follows_requester: number;
    requester_blocks_author: number;
    requester_blocks_author_domain: number;
  }>();
  if (!identities) return false;

  const parseApprovalTargets = (value: string | null | undefined): string[] | null => {
    if (typeof value !== 'string') return null;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed)) return null;
      return parsed.filter((item): item is string => typeof item === 'string');
    } catch {
      return null;
    }
  };

  return canQuoteStatus({
    statusViewable,
    statusVisibility: status.visibility,
    quotePolicy: status.quote_policy,
    requesterIsAuthor,
    requesterFollowsAuthor: identities.requester_follows_author !== 0,
    requesterBlocksAuthor: identities.requester_blocks_author !== 0,
    requesterBlocksAuthorDomain:
      identities.requester_blocks_author_domain !== 0,
    authorFollowsRequester: identities.author_follows_requester !== 0,
    requesterUri: identities.requester_uri,
    authorUri: identities.author_uri,
    automaticApprovalTargets: parseApprovalTargets(status.quote_policy_automatic_approvals),
    manualApprovalTargets: parseApprovalTargets(status.quote_policy_manual_approvals),
  });
}

export async function canQuoteStatusById(
  statusId: string,
  requesterAccountId: string,
): Promise<boolean> {
  const status = await env.DB.prepare(
    `SELECT id, account_id, visibility, deleted_at, quote_policy,
            quote_policy_automatic_approvals, quote_policy_manual_approvals
     FROM statuses WHERE id = ?1 LIMIT 1`,
  ).bind(statusId).first<StatusQuotePermissionRecord>();
  return status ? canQuoteStatusRecord(status, requesterAccountId) : false;
}

export async function assertAccountModeratable(
  actorRole: string | null,
  actorAccountId: string,
  targetAccountId: string,
): Promise<void> {
  const target = await env.DB.prepare(
    `SELECT a.id, u.role
     FROM accounts a
     LEFT JOIN users u ON u.account_id = a.id
     WHERE a.id = ?1
     LIMIT 1`,
  ).bind(targetAccountId).first<{ id: string; role: string | null }>();
  if (!target) throw new AppError(404, 'Record not found');

  if (!canModerateAccount({
    actorRole,
    actorAccountId,
    targetRole: target.role ?? 'user',
    targetAccountId: target.id,
  })) {
    throw new AppError(403, 'This action is not allowed');
  }
}

/**
 * Validates report status references without leaking whether a rejected status
 * exists. Returned IDs are de-duplicated while preserving request order.
 */
export async function assertStatusesViewableForAccount(
  statusIds: string[],
  viewerAccountId: string | null,
  targetAccountId: string,
): Promise<string[]> {
  if (targetAccountId.length === 0 || statusIds.some((statusId) => statusId.length === 0)) {
    throw new AppError(404, 'Record not found');
  }

  const uniqueStatusIds = [...new Set(statusIds)];
  for (const statusId of uniqueStatusIds) {
    const status = await env.DB.prepare(
      'SELECT id, account_id, visibility, deleted_at FROM statuses WHERE id = ?1 LIMIT 1',
    ).bind(statusId).first<StatusPermissionRecord>();
    if (
      !status
      || status.account_id !== targetAccountId
      || !await canViewStatusRecord(status, viewerAccountId)
    ) {
      throw new AppError(404, 'Record not found');
    }
  }

  return uniqueStatusIds;
}

function statusMutationFacts(
  status: StatusMutationPermissionRecord,
  actorAccountId: string,
) {
  return {
    actorAccountId,
    authorAccountId: status.account_id,
    statusDeleted: status.deleted_at !== null,
    statusLocal: status.local === 1,
    reblogOfStatusId: status.reblog_of_id,
    visibility: status.visibility,
  };
}

export function assertStatusMutationAllowedForRecord(
  status: StatusMutationPermissionRecord | null,
  actorAccountId: string,
  mutation: OwnedStatusMutation,
): asserts status is StatusMutationPermissionRecord {
  if (!status || status.deleted_at !== null) {
    throw new AppError(404, 'Record not found');
  }

  const concealOwnership = mutation === 'source';
  if (status.account_id !== actorAccountId) {
    throw concealOwnership
      ? new AppError(404, 'Record not found')
      : new AppError(403, 'This action is not allowed');
  }

  if (!canMutateOwnedStatus(statusMutationFacts(status, actorAccountId), mutation)) {
    throw concealOwnership
      ? new AppError(404, 'Record not found')
      : new AppError(422, 'Validation failed', `Status cannot be used for ${mutation}`);
  }
}

export async function assertStatusMutationAllowed(
  statusId: string,
  actorAccountId: string,
  mutation: OwnedStatusMutation,
): Promise<StatusMutationPermissionRecord> {
  if (statusId.length === 0 || actorAccountId.length === 0) {
    throw new AppError(404, 'Record not found');
  }

  const status = await env.DB.prepare(
    `SELECT id, account_id, visibility, deleted_at, local, reblog_of_id
     FROM statuses
     WHERE id = ?1
     LIMIT 1`,
  ).bind(statusId).first<StatusMutationPermissionRecord>();
  assertStatusMutationAllowedForRecord(status, actorAccountId, mutation);
  return status;
}

export async function assertStatusRebloggable(
  statusId: string,
  actorAccountId: string,
): Promise<StatusPermissionRecord> {
  if (statusId.length === 0 || actorAccountId.length === 0) {
    throw new AppError(404, 'Record not found');
  }

  const status = await env.DB.prepare(
    `SELECT id, account_id, visibility, deleted_at
     FROM statuses
     WHERE id = ?1
     LIMIT 1`,
  ).bind(statusId).first<StatusPermissionRecord>();
  if (!status || !await canViewStatusRecord(status, actorAccountId)) {
    throw new AppError(404, 'Record not found');
  }
  if (!await canAccountOriginateFederationActivity(actorAccountId)) {
    throw new AppError(403, 'This action is not allowed');
  }
  if (!await canAccountInteractWithStatus(statusId, actorAccountId)) {
    throw new AppError(403, 'This action is not allowed');
  }
  if (!canReblogStatus(status.visibility)) {
    throw new AppError(422, 'Validation failed', 'Cannot reblog this status');
  }
  return status;
}

export async function assertMediaAttachmentsAttachable(
  mediaIds: string[],
  actorAccountId: string,
  targetStatusId: string,
): Promise<void> {
  if (mediaIds.length === 0) return;
  if (
    actorAccountId.length === 0
    || targetStatusId.length === 0
    || mediaIds.some((mediaId) => mediaId.length === 0)
    || new Set(mediaIds).size !== mediaIds.length
  ) {
    throw new AppError(422, 'Validation failed', 'Invalid media attachment');
  }

  const placeholders = mediaIds.map(() => '?').join(', ');
  const media = await env.DB.prepare(
    `SELECT id, account_id, status_id
     FROM media_attachments
     WHERE id IN (${placeholders})`,
  ).bind(...mediaIds).all<MediaAttachmentPermissionRecord>();
  const mediaById = new Map(media.results.map((attachment) => [attachment.id, attachment]));
  const allowed = mediaIds.every((mediaId) => {
    const attachment = mediaById.get(mediaId);
    return attachment !== undefined && canAttachMediaToStatus({
      actorAccountId,
      mediaOwnerAccountId: attachment.account_id,
      mediaStatusId: attachment.status_id,
      targetStatusId,
    });
  });
  if (!allowed) {
    throw new AppError(422, 'Validation failed', 'Invalid media attachment');
  }
}

export async function assertPollVoteAllowedForRecord(
  poll: PollVotePermissionRecord,
  actorAccountId: string,
  now: Date = new Date(),
): Promise<void> {
  const statusViewable = await canViewStatusRecord(poll, actorAccountId);
  if (!statusViewable) {
    throw new AppError(404, 'Record not found');
  }

  const actorOperational = await canAccountOriginateFederationActivity(actorAccountId);
  if (!actorOperational) {
    throw new AppError(403, 'This action is not allowed');
  }

  const expirationTime = poll.expires_at === null
    ? null
    : Date.parse(poll.expires_at);
  const pollExpired = expirationTime === null
    ? false
    : Number.isFinite(expirationTime)
      ? expirationTime <= now.getTime()
      : null;
  if (!canVoteInPoll({ actorOperational, statusViewable, pollExpired })) {
    throw new AppError(422, 'Validation failed', 'Poll has ended');
  }
}

export async function resolveLocalStatusCreationVisibility(
  actorAccountId: string,
  requestedVisibility: string,
): Promise<StatusVisibility> {
  if (!parseStatusVisibility(requestedVisibility)) {
    throw new AppError(422, 'Validation failed', 'Invalid status visibility');
  }

  const actor = await env.DB.prepare(
    `SELECT a.domain, a.suspended_at, a.silenced_at, a.memorial,
            a.moved_to_account_id,
            u.disabled AS user_disabled, u.approved AS user_approved
     FROM accounts a
     LEFT JOIN users u ON u.account_id = a.id
     WHERE a.id = ?1
     LIMIT 1`,
  ).bind(actorAccountId).first<{
    domain: string | null;
    suspended_at: string | null;
    silenced_at: string | null;
    memorial: number | null;
    moved_to_account_id: string | null;
    user_disabled: number | null;
    user_approved: number | null;
  }>();
  const actorOperational = canOriginateAccountActivity({
    accountSuspended: actor ? actor.suspended_at !== null : null,
    accountMemorial: actor?.memorial === null || actor?.memorial === undefined
      ? null
      : actor.memorial !== 0,
    isLocalAccount: actor ? actor.domain === null : null,
    userDisabled: actor?.user_disabled === null || actor?.user_disabled === undefined
      ? null
      : actor.user_disabled !== 0,
    userApproved: actor?.user_approved === null || actor?.user_approved === undefined
      ? null
      : actor.user_approved !== 0,
  });
  const resolved = resolveStatusCreationVisibility({
    actorOperational,
    actorIsLocal: actor ? actor.domain === null : null,
    actorMoved: actor ? actor.moved_to_account_id !== null : null,
    actorSilenced: actor ? actor.silenced_at !== null : null,
    requestedVisibility,
  });
  if (!resolved) {
    throw new AppError(403, 'This action is not allowed');
  }
  return resolved;
}
