export const STATUS_VISIBILITIES = [
  'public',
  'unlisted',
  'private',
  'direct',
] as const;

export type StatusVisibility = (typeof STATUS_VISIBILITIES)[number];

export function parseStatusVisibility(
  value: string | null | undefined,
): StatusVisibility | null {
  switch (value) {
    case 'public':
    case 'unlisted':
    case 'private':
    case 'direct':
      return value;
    default:
      return null;
  }
}

export interface StatusViewFacts {
  visibility: string | null;
  viewerAccountId: string | null;
  authorAccountId: string | null;
  viewerFollowsAuthor: boolean;
  viewerIsMentioned: boolean;
  authorBlocksViewer: boolean | null;
  statusDeleted: boolean;
}

function isPresentIdentifier(value: string | null): value is string {
  return value !== null && value.length > 0;
}

export function canViewStatus(facts: StatusViewFacts): boolean {
  const visibility = parseStatusVisibility(facts.visibility);
  if (!visibility || facts.statusDeleted || !isPresentIdentifier(facts.authorAccountId)) {
    return false;
  }

  if (facts.viewerAccountId === facts.authorAccountId) return true;

  switch (visibility) {
    case 'public':
    case 'unlisted':
      return facts.viewerAccountId === null
        || (isPresentIdentifier(facts.viewerAccountId)
          && facts.authorBlocksViewer === false);
    case 'private':
      return isPresentIdentifier(facts.viewerAccountId)
        && (facts.viewerFollowsAuthor || facts.viewerIsMentioned);
    case 'direct':
      return isPresentIdentifier(facts.viewerAccountId) && facts.viewerIsMentioned;
  }
}

export function isPublicTimelineEligible(
  visibility: string | null | undefined,
): boolean {
  return parseStatusVisibility(visibility) === 'public';
}

export interface PublicStatusBroadcastFacts {
  visibility: string | null;
  statusDeleted: boolean | null;
  authorSuspended: boolean | null;
  authorSilenced: boolean | null;
}

export function canBroadcastStatusToPublicStreams(
  facts: PublicStatusBroadcastFacts,
): boolean {
  return isPublicTimelineEligible(facts.visibility)
    && facts.statusDeleted === false
    && facts.authorSuspended === false
    && facts.authorSilenced === false;
}

export function canReblogStatus(
  visibility: string | null | undefined,
): boolean {
  const parsed = parseStatusVisibility(visibility);
  return parsed === 'public' || parsed === 'unlisted';
}

export const USER_ROLES = ['user', 'moderator', 'admin'] as const;

export type UserRole = (typeof USER_ROLES)[number];

export function parseUserRole(value: string | null | undefined): UserRole | null {
  switch (value) {
    case 'user':
    case 'moderator':
    case 'admin':
      return value;
    default:
      return null;
  }
}

export type StaffCapability =
  | 'moderation:read'
  | 'accounts:moderate'
  | 'roles:manage'
  | 'instance:manage';

export function hasStaffCapability(
  role: string | null | undefined,
  capability: StaffCapability,
): boolean {
  const parsedRole = parseUserRole(role);
  if (parsedRole === 'admin') return true;
  if (parsedRole !== 'moderator') return false;
  return capability === 'moderation:read' || capability === 'accounts:moderate';
}

const INTERNAL_SESSION_BASE_SCOPES = ['read', 'write', 'follow', 'push'] as const;
const INTERNAL_SESSION_STAFF_SCOPES = ['admin:read', 'admin:write'] as const;

/**
 * Scopes for sessions issued by the built-in frontend. OAuth clients must use
 * their registered/requested scopes instead and must never derive them from a
 * user's role.
 */
export function getInternalSessionOAuthScopes(
  role: string | null | undefined,
): string {
  const parsedRole = parseUserRole(role);
  const scopes = parsedRole === 'admin' || parsedRole === 'moderator'
    ? [...INTERNAL_SESSION_BASE_SCOPES, ...INTERNAL_SESSION_STAFF_SCOPES]
    : INTERNAL_SESSION_BASE_SCOPES;
  return scopes.join(' ');
}

export interface AccountModerationFacts {
  actorRole: string | null;
  actorAccountId: string | null;
  targetRole: string | null;
  targetAccountId: string | null;
}

export function canModerateAccount(facts: AccountModerationFacts): boolean {
  const actorRole = parseUserRole(facts.actorRole);
  const targetRole = parseUserRole(facts.targetRole);
  if (
    !actorRole
    || !targetRole
    || !isPresentIdentifier(facts.actorAccountId)
    || !isPresentIdentifier(facts.targetAccountId)
    || facts.actorAccountId === facts.targetAccountId
  ) {
    return false;
  }

  if (actorRole === 'admin') return true;
  return actorRole === 'moderator' && targetRole === 'user';
}

export interface AccountOperationalFacts {
  accountSuspended: boolean | null;
  userDisabled: boolean | null;
  userApproved: boolean | null;
  memorial: boolean | null;
}

export function canActAsAccount(facts: AccountOperationalFacts): boolean {
  return facts.accountSuspended === false
    && facts.userDisabled === false
    && facts.userApproved === true
    && facts.memorial === false;
}

export interface AccountViewFacts {
  accountSuspended: boolean | null;
}

/**
 * Canonical account resources must not expose suspended identities. Frozen
 * (disabled) accounts remain readable; disabled is an authentication/action
 * state rather than a profile deletion state.
 */
export function canViewAccount(facts: AccountViewFacts): boolean {
  return facts.accountSuspended === false;
}

export interface AccountCollectionViewFacts {
  ownerAccountId: string | null;
  viewerAccountId: string | null;
  collectionsHidden: boolean | null;
}

/**
 * Social-graph collections are public by default for compatibility. Once an
 * account hides its collections, only the exact owner may read their items.
 * Unknown privacy state fails closed for everyone except the owner.
 */
export function canViewAccountCollection(
  facts: AccountCollectionViewFacts,
): boolean {
  if (!isPresentIdentifier(facts.ownerAccountId)) return false;
  if (facts.viewerAccountId === facts.ownerAccountId) return true;
  return facts.collectionsHidden === false;
}

export interface RemoteAccountCollectionAvailabilityFacts {
  followersAdvertised: boolean;
  followingAdvertised: boolean;
  followersFirstPageAvailable: boolean;
  followingFirstPageAvailable: boolean;
}

/**
 * A remote social graph is public only when both advertised collections expose
 * a first page. This matches ActivityPub collection discovery semantics and
 * fails closed when fetching either collection is refused or unavailable.
 */
export function shouldHideRemoteAccountCollections(
  facts: RemoteAccountCollectionAvailabilityFacts,
): boolean {
  return !facts.followersAdvertised
    || !facts.followingAdvertised
    || !facts.followersFirstPageAvailable
    || !facts.followingFirstPageAvailable;
}

export interface AccountSurfaceFacts extends AccountViewFacts {
  isLocalAccount: boolean | null;
  localUserApproved: boolean | null;
  accountSilenced: boolean | null;
  viewerIsAccount: boolean;
  viewerFollowsAccount: boolean;
  viewerMutesAccount: boolean | null;
  viewerBlocksAccount: boolean | null;
  viewerBlocksAccountDomain: boolean | null;
  accountBlocksViewer: boolean | null;
}

/**
 * Applies discovery suppression on top of canonical account availability.
 * Exact profile and acct lookups use canViewAccount instead, so mute and block
 * state never turns a canonical resource into an existence oracle.
 */
export function canSurfaceAccount(facts: AccountSurfaceFacts): boolean {
  const approvedForDiscovery = facts.isLocalAccount === false
    || (facts.isLocalAccount === true && facts.localUserApproved === true);
  const silencedAccountAllowed = facts.accountSilenced === false
    || (facts.accountSilenced === true
      && (facts.viewerIsAccount || facts.viewerFollowsAccount));

  return canViewAccount(facts)
    && approvedForDiscovery
    && silencedAccountAllowed
    && facts.viewerMutesAccount === false
    && facts.viewerBlocksAccount === false
    && facts.viewerBlocksAccountDomain === false
    && facts.accountBlocksViewer === false;
}

export interface AccountSearchFacts extends AccountViewFacts {
  isLocalAccount: boolean | null;
  localUserApproved: boolean | null;
  accountMoved: boolean | null;
  viewerMutesAccount: boolean | null;
  viewerBlocksAccount: boolean | null;
  viewerBlocksAccountDomain: boolean | null;
  accountBlocksViewer: boolean | null;
}

/** Search keeps limited accounts discoverable, but omits moved identities. */
export function canSearchAccount(facts: AccountSearchFacts): boolean {
  const approvedForSearch = facts.isLocalAccount === false
    || (facts.isLocalAccount === true && facts.localUserApproved === true);
  return canViewAccount(facts)
    && approvedForSearch
    && facts.accountMoved === false
    && facts.viewerMutesAccount === false
    && facts.viewerBlocksAccount === false
    && facts.viewerBlocksAccountDomain === false
    && facts.accountBlocksViewer === false;
}

export interface AccountFollowFacts {
  actorAccountId: string | null;
  targetAccountId: string | null;
  targetViewable: boolean;
  targetMemorial: boolean | null;
  targetMoved: boolean | null;
  actorBlocksTarget: boolean | null;
  actorBlocksTargetDomain: boolean | null;
  targetBlocksActor: boolean | null;
}

export function canFollowAccount(facts: AccountFollowFacts): boolean {
  return isPresentIdentifier(facts.actorAccountId)
    && isPresentIdentifier(facts.targetAccountId)
    && facts.actorAccountId !== facts.targetAccountId
    && facts.targetViewable === true
    && facts.targetMemorial === false
    && facts.targetMoved === false
    && facts.actorBlocksTarget === false
    && facts.actorBlocksTargetDomain === false
    && facts.targetBlocksActor === false;
}

export interface BlockOrMuteAccountRelationshipFacts {
  actorAccountId: string | null;
  targetAccountId: string | null;
  actorOperational: boolean | null;
  targetExists: boolean;
}

/** New block and mute relationships require an active, non-self actor. */
export function canCreateBlockOrMuteAccountRelationship(
  facts: BlockOrMuteAccountRelationshipFacts,
): boolean {
  return isPresentIdentifier(facts.actorAccountId)
    && isPresentIdentifier(facts.targetAccountId)
    && facts.actorAccountId !== facts.targetAccountId
    && facts.actorOperational === true
    && facts.targetExists;
}

export interface FetchedRemoteActorFacts {
  requestedActorUri: string | null;
  actorUri: string | null;
  localInstanceDomain: string | null;
  actorSuspended: boolean | null;
}

function parseRemoteHttpUrl(value: string | null): URL | null {
  if (!isPresentIdentifier(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/** URI identity keeps path/query case exact while normalizing DNS host case. */
export function areActivityPubUrisEquivalent(
  first: string | null,
  second: string | null,
): boolean {
  const firstUrl = parseRemoteHttpUrl(first);
  const secondUrl = parseRemoteHttpUrl(second);
  return firstUrl !== null
    && secondUrl !== null
    && firstUrl.href === secondUrl.href;
}

/** A fetched actor document may update only the exact requested remote actor. */
export function canStoreFetchedRemoteActor(
  facts: FetchedRemoteActorFacts,
): boolean {
  const requested = parseRemoteHttpUrl(facts.requestedActorUri);
  const actor = parseRemoteHttpUrl(facts.actorUri);
  if (!requested || !actor || !isPresentIdentifier(facts.localInstanceDomain)) {
    return false;
  }

  return requested.href === actor.href
    && actor.hostname.toLowerCase() !== facts.localInstanceDomain.toLowerCase()
    && facts.actorSuspended === false;
}

export interface FetchedRemoteStatusFacts {
  requestedStatusUri: string | null;
  statusUri: string | null;
  /** Human-facing URLs explicitly advertised by the fetched AP object. */
  statusUrlAliases?: readonly string[];
  authorUri: string | null;
  localInstanceDomain: string | null;
  authorSuspended: boolean | null;
}

/**
 * Directly fetched objects need exact resource identity, or an exact match
 * against a same-host URL explicitly advertised by the fetched object, plus
 * trustworthy same-host attribution. The advertised-URL case permits normal
 * fediverse permalinks whose HTML points to a separate canonical AP object.
 * Otherwise any remote host could claim a local or unrelated actor as the
 * author of an attacker-controlled object.
 */
export function canStoreFetchedRemoteStatus(
  facts: FetchedRemoteStatusFacts,
): boolean {
  const requested = parseRemoteHttpUrl(facts.requestedStatusUri);
  const status = parseRemoteHttpUrl(facts.statusUri);
  const author = parseRemoteHttpUrl(facts.authorUri);
  if (
    !requested
    || !status
    || !author
    || !isPresentIdentifier(facts.localInstanceDomain)
  ) {
    return false;
  }

  const localDomain = facts.localInstanceDomain.toLowerCase();
  const requestedMatchesAdvertisedUrl = facts.statusUrlAliases?.some((value) => {
    const advertised = parseRemoteHttpUrl(value);
    return advertised?.href === requested.href
      && advertised.hostname.toLowerCase() === status.hostname.toLowerCase();
  }) ?? false;

  return (requested.href === status.href || requestedMatchesAdvertisedUrl)
    && status.hostname.toLowerCase() === author.hostname.toLowerCase()
    && status.hostname.toLowerCase() !== localDomain
    && author.hostname.toLowerCase() !== localDomain
    && facts.authorSuspended === false;
}

export interface FollowRequestPermissionFacts {
  requesterAccountId: string | null;
  targetAccountId: string | null;
  requesterOperational: AccountActivityOriginatorFacts;
  requesterBlocksTarget: boolean | null;
  targetBlocksRequester: boolean | null;
  targetBlocksRequesterDomain: boolean | null;
}

/** Pending requests are actionable only while the requester remains eligible. */
export function canProcessFollowRequest(
  facts: FollowRequestPermissionFacts,
): boolean {
  return isPresentIdentifier(facts.requesterAccountId)
    && isPresentIdentifier(facts.targetAccountId)
    && facts.requesterAccountId !== facts.targetAccountId
    && canOriginateAccountActivity(facts.requesterOperational)
    && facts.requesterBlocksTarget === false
    && facts.targetBlocksRequester === false
    && facts.targetBlocksRequesterDomain === false;
}

export interface FederatedFollowPermissionFacts
  extends FollowRequestPermissionFacts {
  recipientAccountId: string | null;
  requesterIsRemote: boolean | null;
  targetIsLocal: boolean | null;
  targetMoved: boolean | null;
  targetOperational: AccountOperationalFacts;
}

/** An inbound Follow may mutate only its active personal-inbox target. */
export function canReceiveFederatedFollow(
  facts: FederatedFollowPermissionFacts,
): boolean {
  return canProcessFollowRequest(facts)
    && facts.requesterIsRemote === true
    && facts.targetIsLocal === true
    && facts.targetMoved === false
    && canActAsAccount(facts.targetOperational)
    && (facts.recipientAccountId === null
      || facts.recipientAccountId === facts.targetAccountId);
}

export interface FederatedAccountTargetPermissionFacts {
  actorAccountId: string | null;
  targetAccountId: string | null;
  recipientAccountId: string | null;
  actorOperational: AccountActivityOriginatorFacts;
  actorIsRemote: boolean | null;
  targetIsLocal: boolean | null;
}

/** Signed account-targeting activities may mutate only their local inbox target. */
export function canProcessFederatedAccountTarget(
  facts: FederatedAccountTargetPermissionFacts,
): boolean {
  return isPresentIdentifier(facts.actorAccountId)
    && isPresentIdentifier(facts.targetAccountId)
    && facts.actorAccountId !== facts.targetAccountId
    && canOriginateAccountActivity(facts.actorOperational)
    && facts.actorIsRemote === true
    && facts.targetIsLocal === true
    && (facts.recipientAccountId === null
      || facts.recipientAccountId === facts.targetAccountId);
}

export interface FederatedAccountUndoPermissionFacts
  extends FederatedAccountTargetPermissionFacts {
  embeddedActorMatches: boolean;
  storedTargetMatches: boolean;
}

/** Undo may remove only the signed actor's exact stored account relationship. */
export function canUndoFederatedAccountAction(
  facts: FederatedAccountUndoPermissionFacts,
): boolean {
  return canProcessFederatedAccountTarget(facts)
    && facts.embeddedActorMatches
    && facts.storedTargetMatches;
}

export interface FederatedActorUpdatePermissionFacts {
  actorAccountId: string | null;
  ownerAccountId: string | null;
  actorIsRemote: boolean | null;
  actorOperational: AccountActivityOriginatorFacts;
}

/** A remote Update may change only an active actor's own cached resource. */
export function canApplyFederatedActorUpdate(
  facts: FederatedActorUpdatePermissionFacts,
): boolean {
  return canMutateOwnedFederatedResource(facts)
    && facts.actorIsRemote === true
    && canOriginateAccountActivity(facts.actorOperational);
}

export interface FederatedDeletePermissionFacts {
  actorAccountId: string | null;
  ownerAccountId: string | null;
  actorIsRemote: boolean | null;
}

/**
 * A remote Delete may remove only its actor's own cached resource. Suspended
 * actors deliberately remain eligible so a final self-delete can clean up
 * content that was cached before suspension.
 */
export function canApplyFederatedDelete(
  facts: FederatedDeletePermissionFacts,
): boolean {
  return canMutateOwnedFederatedResource(facts)
    && facts.actorIsRemote === true;
}

export interface FederatedMovePermissionFacts {
  actorAccountId: string | null;
  oldAccountId: string | null;
  newAccountId: string | null;
  recipientAccountId: string | null;
  actorIsRemote: boolean | null;
  actorOperational: AccountActivityOriginatorFacts;
  newAccountOperational: AccountActivityOriginatorFacts;
  newAccountMoved: boolean | null;
  newAccountAliasesOld: boolean;
  oldMovedToAccountId: string | null;
  recipientIsLocal: boolean | null;
  recipientFollowsOld: boolean | null;
  recipientOperational: AccountOperationalFacts | null;
}

/**
 * Move is accepted only from the remote old actor, toward an active verified
 * alias. A personal inbox must belong to an active local follower; null is the
 * shared inbox. Replays to the same target are allowed for idempotent recovery,
 * while changing an existing redirect is denied.
 */
export function canProcessFederatedMove(
  facts: FederatedMovePermissionFacts,
): boolean {
  const sharedInbox = facts.recipientAccountId === null;
  const validPersonalInbox = isPresentIdentifier(facts.recipientAccountId)
    && facts.recipientIsLocal === true
    && facts.recipientFollowsOld === true
    && facts.recipientOperational !== null
    && canActAsAccount(facts.recipientOperational);

  return isPresentIdentifier(facts.actorAccountId)
    && facts.actorAccountId === facts.oldAccountId
    && isPresentIdentifier(facts.newAccountId)
    && facts.oldAccountId !== facts.newAccountId
    && facts.actorIsRemote === true
    && canOriginateAccountActivity(facts.actorOperational)
    && canOriginateAccountActivity(facts.newAccountOperational)
    && facts.newAccountMoved === false
    && facts.newAccountAliasesOld
    && (facts.oldMovedToAccountId === null
      || facts.oldMovedToAccountId === facts.newAccountId)
    && (sharedInbox || validPersonalInbox);
}

export interface FederatedMoveRefollowPermissionFacts {
  followerAccountId: string | null;
  oldAccountId: string | null;
  newAccountId: string | null;
  followerOperational: AccountActivityOriginatorFacts;
  followsOld: boolean;
  alreadyFollowsNew: boolean;
  alreadyRequestedNew: boolean;
  followerBlocksNew: boolean | null;
  followerBlocksNewDomain: boolean | null;
  newBlocksFollower: boolean | null;
}

/** Per-follower consent and relationship state are revalidated before Move. */
export function canRefollowAfterFederatedMove(
  facts: FederatedMoveRefollowPermissionFacts,
): boolean {
  return isPresentIdentifier(facts.followerAccountId)
    && isPresentIdentifier(facts.oldAccountId)
    && isPresentIdentifier(facts.newAccountId)
    && facts.oldAccountId !== facts.newAccountId
    && canOriginateAccountActivity(facts.followerOperational)
    && facts.followsOld
    && !facts.alreadyFollowsNew
    && !facts.alreadyRequestedNew
    && facts.followerBlocksNew === false
    && facts.followerBlocksNewDomain === false
    && facts.newBlocksFollower === false;
}

export interface ListMemberPermissionFacts {
  actorAccountId: string | null;
  listOwnerAccountId: string | null;
  memberAccountId: string | null;
  memberOperational: AccountActivityOriginatorFacts;
  actorFollowsMember: boolean;
  actorBlocksMember: boolean | null;
  memberBlocksActor: boolean | null;
}

/** Lists contain only active accounts followed by the list owner. */
export function canAddAccountToList(facts: ListMemberPermissionFacts): boolean {
  return isPresentIdentifier(facts.actorAccountId)
    && facts.actorAccountId === facts.listOwnerAccountId
    && isPresentIdentifier(facts.memberAccountId)
    && facts.memberAccountId !== facts.actorAccountId
    && canOriginateAccountActivity(facts.memberOperational)
    && facts.actorFollowsMember
    && facts.actorBlocksMember === false
    && facts.memberBlocksActor === false;
}

export interface AccountFeatureFacts {
  actorAccountId: string | null;
  targetAccountId: string | null;
  targetViewable: boolean;
  actorFollowsTarget: boolean;
}

export function canFeatureAccount(facts: AccountFeatureFacts): boolean {
  return isPresentIdentifier(facts.actorAccountId)
    && isPresentIdentifier(facts.targetAccountId)
    && facts.actorAccountId !== facts.targetAccountId
    && facts.targetViewable === true
    && facts.actorFollowsTarget;
}

export interface AccountRelationshipViewFacts {
  targetExists: boolean;
  targetSuspended: boolean | null;
  includeSuspended: boolean;
}

export function canViewAccountRelationship(
  facts: AccountRelationshipViewFacts,
): boolean {
  return facts.targetExists
    && (facts.targetSuspended === false
      || (facts.targetSuspended === true && facts.includeSuspended));
}

export interface AccountActivityOriginatorFacts {
  accountSuspended: boolean | null;
  accountMemorial: boolean | null;
  isLocalAccount: boolean | null;
  userDisabled: boolean | null;
  userApproved: boolean | null;
}

/**
 * Remote actors have no users row. A local actor must have an enabled,
 * approved user; both kinds of actor must have an active account.
 */
export function canOriginateAccountActivity(
  facts: AccountActivityOriginatorFacts,
): boolean {
  if (
    facts.accountSuspended !== false
    || facts.accountMemorial !== false
    || facts.isLocalAccount === null
  ) {
    return false;
  }

  return facts.isLocalAccount
    ? facts.userDisabled === false && facts.userApproved === true
    : facts.userDisabled === null && facts.userApproved === null;
}

export interface ActivityPubPublicCollectionStatusFacts {
  visibility: string | null;
  statusDeleted: boolean | null;
  authorAvailable: boolean | null;
}

/** Public ActivityPub collections never carry follower-only or direct data. */
export function canExposeStatusInActivityPubPublicCollection(
  facts: ActivityPubPublicCollectionStatusFacts,
): boolean {
  const visibility = parseStatusVisibility(facts.visibility);
  return (visibility === 'public' || visibility === 'unlisted')
    && facts.statusDeleted === false
    && facts.authorAvailable === true;
}

export interface FederatedReportPermissionFacts {
  reporterAccountId: string | null;
  targetAccountId: string | null;
  recipientAccountId: string | null;
  reporterOperational: boolean;
  reporterIsRemote: boolean | null;
  targetOperational: boolean;
  targetIsLocal: boolean | null;
  allStatusReferencesAuthorized: boolean;
}

/**
 * A Flag may arrive through the shared inbox, or through the exact target
 * actor's personal inbox. A valid signature never grants authority to report
 * as a suspended/local actor or to attach unrelated status records.
 */
export function canAcceptFederatedReport(
  facts: FederatedReportPermissionFacts,
): boolean {
  const sharedInbox = facts.recipientAccountId === null;
  const exactPersonalInbox = isPresentIdentifier(facts.recipientAccountId)
    && facts.recipientAccountId === facts.targetAccountId;

  return isPresentIdentifier(facts.reporterAccountId)
    && isPresentIdentifier(facts.targetAccountId)
    && facts.reporterAccountId !== facts.targetAccountId
    && facts.reporterOperational
    && facts.reporterIsRemote === true
    && facts.targetOperational
    && facts.targetIsLocal === true
    && (sharedInbox || exactPersonalInbox)
    && facts.allStatusReferencesAuthorized;
}

export interface StatusSurfaceFacts {
  statusViewable: boolean;
  authorSuspended: boolean | null;
  authorSilenced: boolean | null;
  viewerIsAuthor: boolean;
  viewerFollowsAuthor: boolean;
  viewerMutesAuthor: boolean | null;
  viewerBlocksAuthor: boolean | null;
  viewerBlocksAuthorDomain: boolean | null;
  authorBlocksViewer: boolean | null;
}

/**
 * Applies relationship suppression for timelines and notifications. Direct
 * status fetches intentionally use canViewStatus instead so mute/block state
 * does not change the canonical resource URL contract.
 */
export function canSurfaceStatus(facts: StatusSurfaceFacts): boolean {
  const silencedAuthorAllowed = facts.authorSilenced === false
    || (facts.authorSilenced === true && (facts.viewerIsAuthor || facts.viewerFollowsAuthor));
  return facts.statusViewable === true
    && facts.authorSuspended === false
    && silencedAuthorAllowed
    && facts.viewerMutesAuthor === false
    && facts.viewerBlocksAuthor === false
    && facts.viewerBlocksAuthorDomain === false
    && facts.authorBlocksViewer === false;
}

export interface StatusInteractionFacts {
  statusViewable: boolean;
  actorSuspended: boolean | null;
  actorBlocksAuthor: boolean | null;
  actorBlocksAuthorDomain: boolean | null;
}

export function canInteractWithStatus(facts: StatusInteractionFacts): boolean {
  return facts.statusViewable === true
    && facts.actorSuspended === false
    && facts.actorBlocksAuthor === false
    && facts.actorBlocksAuthorDomain === false;
}

export interface StatusQuoteFacts {
  statusViewable: boolean;
  statusVisibility: string | null;
  quotePolicy: string | null;
  requesterIsAuthor: boolean;
  requesterFollowsAuthor: boolean;
  requesterBlocksAuthor: boolean | null;
  requesterBlocksAuthorDomain: boolean | null;
  authorFollowsRequester?: boolean;
  requesterUri?: string | null;
  authorUri?: string | null;
  automaticApprovalTargets?: readonly string[] | null;
  manualApprovalTargets?: readonly string[] | null;
}

/**
 * Quote attachment is stricter than canonical status viewing. Other users may
 * quote public/unlisted posts according to the author's policy; an author may
 * additionally quote their own private post. Direct posts are never quotable.
 */
export function canQuoteStatus(facts: StatusQuoteFacts): boolean {
  const visibility = parseStatusVisibility(facts.statusVisibility);
  if (!facts.statusViewable || !visibility || visibility === 'direct') return false;

  if (facts.requesterIsAuthor) return true;
  if (visibility !== 'public' && visibility !== 'unlisted') return false;
  if (
    facts.requesterBlocksAuthor !== false
    || facts.requesterBlocksAuthorDomain !== false
  ) return false;

  const hasRawPolicy = facts.automaticApprovalTargets != null
    || facts.manualApprovalTargets != null;
  if (hasRawPolicy) {
    const requesterUri = facts.requesterUri ?? null;
    const authorUri = facts.authorUri ?? null;
    const approvals = [
      ...(facts.automaticApprovalTargets ?? []),
      ...(facts.manualApprovalTargets ?? []),
    ];
    if (
      approvals.includes('https://www.w3.org/ns/activitystreams#Public')
      || approvals.includes('as:Public')
      || approvals.includes('Public')
    ) {
      return true;
    }
    if (isPresentIdentifier(requesterUri) && approvals.includes(requesterUri)) {
      return true;
    }
    if (!isPresentIdentifier(authorUri)) return false;
    if (
      approvals.includes(`${authorUri}/followers`)
      && facts.requesterFollowsAuthor
    ) {
      return true;
    }
    return approvals.includes(`${authorUri}/following`)
      && facts.authorFollowsRequester === true;
  }

  switch (facts.quotePolicy) {
    case 'public':
      return true;
    case 'followers':
      return facts.requesterFollowsAuthor;
    case 'nobody':
    default:
      return false;
  }
}

/** Keeps a quote wrapper at least as restrictive as a private target. */
export function constrainQuoteVisibility(
  requestedVisibility: string | null | undefined,
  targetVisibility: string | null | undefined,
): StatusVisibility | null {
  const requested = parseStatusVisibility(requestedVisibility);
  const target = parseStatusVisibility(targetVisibility);
  if (!requested || !target || target === 'direct') return null;
  if (target !== 'private') return requested;
  return requested === 'direct' ? 'direct' : 'private';
}

export interface QuoteEmbeddingFacts {
  quoteStatusId: string | null;
  quoteApprovalStatus: string | null;
}

/** Pending, rejected, revoked, and malformed quote relationships stay hidden. */
export function canEmbedQuote(facts: QuoteEmbeddingFacts): boolean {
  return isPresentIdentifier(facts.quoteStatusId)
    && facts.quoteApprovalStatus === 'accepted';
}

export interface OwnedFederatedResourceFacts {
  actorAccountId: string | null;
  ownerAccountId: string | null;
}

/** A signed activity may mutate only a resource attributed to its actor. */
export function canMutateOwnedFederatedResource(
  facts: OwnedFederatedResourceFacts,
): boolean {
  return isPresentIdentifier(facts.actorAccountId)
    && facts.actorAccountId === facts.ownerAccountId;
}

export interface FederatedResponseFacts extends OwnedFederatedResourceFacts {
  localInitiatorAccountId: string | null;
  recipientAccountId: string | null;
  localInitiatorIsLocal: boolean;
  requestPending: boolean;
  embeddedInitiatorMatches: boolean;
  embeddedOwnerMatches: boolean;
}

/**
 * A remote response can resolve only its own pending request from a local
 * initiator. Personal-inbox delivery must match that initiator; null denotes
 * the shared inbox.
 */
export function canApplyFederatedResponse(facts: FederatedResponseFacts): boolean {
  return canMutateOwnedFederatedResource(facts)
    && isPresentIdentifier(facts.localInitiatorAccountId)
    && facts.localInitiatorIsLocal
    && facts.requestPending
    && facts.embeddedInitiatorMatches
    && facts.embeddedOwnerMatches
    && (facts.recipientAccountId === null
      || facts.recipientAccountId === facts.localInitiatorAccountId);
}

export interface QuoteResponseFacts extends OwnedFederatedResourceFacts {
  localQuoteAuthorAccountId: string | null;
  recipientAccountId: string | null;
  quoteApprovalStatus: string | null;
}

/**
 * Accept/Reject can resolve only a pending quote owned by the local inbox
 * recipient, and only when the response actor authored the quoted target.
 * A null recipient represents the shared inbox.
 */
export function canApplyQuoteResponse(facts: QuoteResponseFacts): boolean {
  return canApplyFederatedResponse({
    actorAccountId: facts.actorAccountId,
    ownerAccountId: facts.ownerAccountId,
    localInitiatorAccountId: facts.localQuoteAuthorAccountId,
    recipientAccountId: facts.recipientAccountId,
    localInitiatorIsLocal: true,
    requestPending: facts.quoteApprovalStatus === 'pending',
    embeddedInitiatorMatches: true,
    embeddedOwnerMatches: true,
  });
}

export interface NotificationDeliveryFacts {
  recipientOperational: AccountOperationalFacts;
  senderOperational: NotificationOriginatorFacts;
  viewerMutesSender: boolean | null;
  viewerBlocksSender: boolean | null;
  viewerBlocksSenderDomain: boolean | null;
  senderBlocksViewer: boolean | null;
  statusBearing: boolean;
  statusSurface: StatusSurfaceFacts | null;
  viewerMutesStatusThread: boolean | null;
}

export type NotificationOriginatorFacts = AccountActivityOriginatorFacts;

/**
 * Remote actors do not have a users row. Local actors must have an enabled
 * user, while both local and remote actors must be active accounts.
 */
export function canOriginateNotification(
  facts: NotificationOriginatorFacts,
): boolean {
  return canOriginateAccountActivity(facts);
}

export function canDeliverNotification(facts: NotificationDeliveryFacts): boolean {
  if (
    !canActAsAccount(facts.recipientOperational)
    || !canOriginateNotification(facts.senderOperational)
  ) {
    return false;
  }

  const relationshipAllowed = facts.viewerMutesSender === false
    && facts.viewerBlocksSender === false
    && facts.viewerBlocksSenderDomain === false
    && facts.senderBlocksViewer === false;
  if (!relationshipAllowed) return false;

  return facts.statusBearing
    ? facts.statusSurface !== null
      && canSurfaceStatus(facts.statusSurface)
      && facts.viewerMutesStatusThread === false
    : facts.statusSurface === null && facts.viewerMutesStatusThread === null;
}

const FOLLOW_SCOPES = new Set([
  'read:follows',
  'write:follows',
  'read:blocks',
  'write:blocks',
  'read:mutes',
  'write:mutes',
]);

const READ_SCOPES = new Set([
  'read:accounts',
  'read:blocks',
  'read:bookmarks',
  'read:collections',
  'read:favourites',
  'read:filters',
  'read:follows',
  'read:lists',
  'read:mutes',
  'read:notifications',
  'read:search',
  'read:statuses',
]);

const WRITE_SCOPES = new Set([
  'write:accounts',
  'write:blocks',
  'write:bookmarks',
  'write:collections',
  'write:conversations',
  'write:favourites',
  'write:filters',
  'write:follows',
  'write:lists',
  'write:media',
  'write:mutes',
  'write:notifications',
  'write:reports',
  'write:statuses',
]);

const ADMIN_READ_SCOPES = new Set([
  'admin:read:accounts',
  'admin:read:canonical_email_blocks',
  'admin:read:domain_allows',
  'admin:read:domain_blocks',
  'admin:read:email_domain_blocks',
  'admin:read:ip_blocks',
  'admin:read:reports',
]);

const ADMIN_WRITE_SCOPES = new Set([
  'admin:write:accounts',
  'admin:write:canonical_email_blocks',
  'admin:write:domain_allows',
  'admin:write:domain_blocks',
  'admin:write:email_domain_blocks',
  'admin:write:ip_blocks',
  'admin:write:reports',
]);

export function hasOAuthScope(
  grantedScopes: string | null | undefined,
  requiredScope: string,
): boolean {
  if (!grantedScopes || requiredScope.length === 0) return false;
  const granted = new Set(grantedScopes.split(/\s+/).filter((scope) => scope.length > 0));
  if (granted.has(requiredScope)) return true;

  if (granted.has('read') && READ_SCOPES.has(requiredScope)) return true;
  if (granted.has('write') && WRITE_SCOPES.has(requiredScope)) return true;
  if (granted.has('admin:read') && ADMIN_READ_SCOPES.has(requiredScope)) return true;
  if (granted.has('admin:write') && ADMIN_WRITE_SCOPES.has(requiredScope)) return true;

  if (granted.has('follow') && FOLLOW_SCOPES.has(requiredScope)) return true;
  return false;
}

export function hasAnyOAuthScope(
  grantedScopes: string | null | undefined,
  requiredScopes: readonly string[],
): boolean {
  return requiredScopes.length > 0
    && requiredScopes.some((scope) => hasOAuthScope(grantedScopes, scope));
}

/** Requested OAuth scopes may never exceed the application's registered set. */
export function areOAuthScopesAllowed(
  registeredScopes: string | null | undefined,
  requestedScopes: string | null | undefined,
): boolean {
  if (!registeredScopes || !requestedScopes) return false;
  const requested = requestedScopes
    .split(/\s+/)
    .filter((scope) => scope.length > 0);
  return requested.length > 0
    && requested.every((scope) => hasOAuthScope(registeredScopes, scope));
}

export const STREAMING_CHANNELS = [
  'user',
  'user:notification',
  'public',
  'public:local',
  'hashtag',
  'hashtag:local',
  'list',
  'direct',
] as const;

export type StreamingChannel = (typeof STREAMING_CHANNELS)[number];

export function parseStreamingChannel(value: string | null | undefined): StreamingChannel | null {
  switch (value) {
    case 'user':
    case 'user:notification':
    case 'public':
    case 'public:local':
    case 'hashtag':
    case 'hashtag:local':
    case 'list':
    case 'direct':
      return value;
    default:
      return null;
  }
}

export function canAccessStreamingChannel(
  grantedScopes: string | null | undefined,
  channel: string | null | undefined,
): boolean {
  const parsed = parseStreamingChannel(channel);
  if (!parsed) return false;
  if (parsed === 'user' || parsed === 'user:notification') {
    return hasOAuthScope(grantedScopes, 'read:statuses')
      && hasOAuthScope(grantedScopes, 'read:notifications');
  }
  return hasOAuthScope(grantedScopes, 'read:statuses');
}

export function permittedStreamingChannels(
  grantedScopes: string | null | undefined,
): StreamingChannel[] {
  return STREAMING_CHANNELS.filter(
    (channel) => canAccessStreamingChannel(grantedScopes, channel),
  );
}

export interface StatusFanOutFacts {
  statusAccountId: string | null;
  messageAccountId: string | null;
  visibility: string | null;
  statusDeleted: boolean | null;
  authorSuspended: boolean | null;
}

export function canFanOutStatus(facts: StatusFanOutFacts): boolean {
  const visibility = parseStatusVisibility(facts.visibility);
  return isPresentIdentifier(facts.statusAccountId)
    && isPresentIdentifier(facts.messageAccountId)
    && facts.statusAccountId === facts.messageAccountId
    && visibility !== null
    && visibility !== 'direct'
    && facts.statusDeleted === false
    && facts.authorSuspended === false;
}

export interface ActivitySigningFacts {
  principalUri: string | null;
  activityActorUri: string | null;
  isLocalPrincipal: boolean | null;
  principalSuspended: boolean | null;
  principalMemorial: boolean | null;
  principalUserDisabled: boolean | null;
  principalUserApproved: boolean | null;
  isSystemPrincipal: boolean | null;
  hasSigningKey: boolean | null;
}

export function canSignActivity(facts: ActivitySigningFacts): boolean {
  const principalHasAuthority = facts.isSystemPrincipal === true
    ? facts.principalUserDisabled !== true
      && facts.principalUserApproved !== false
    : facts.isSystemPrincipal === false
      && facts.principalUserDisabled === false
      && facts.principalUserApproved === true;

  return isPresentIdentifier(facts.principalUri)
    && isPresentIdentifier(facts.activityActorUri)
    && facts.principalUri === facts.activityActorUri
    && facts.isLocalPrincipal === true
    && facts.principalSuspended === false
    && facts.principalMemorial === false
    && principalHasAuthority
    && facts.hasSigningKey === true;
}

export interface TerminalActorDeleteSigningFacts extends ActivitySigningFacts {
  activityType: string | null;
  activityObjectUri: string | null;
}

/**
 * Suspension is normally a hard signing boundary. The one exception is the
 * terminal self-Delete emitted after a local account is suspended, so remote
 * servers can remove the actor and its content. Keep this separate from the
 * ordinary signing policy: only an exact string URI match for both actor and
 * object can use the suspended account's key.
 */
export function canSignTerminalActorDelete(
  facts: TerminalActorDeleteSigningFacts,
): boolean {
  return facts.activityType === 'Delete'
    && isPresentIdentifier(facts.principalUri)
    && facts.activityActorUri === facts.principalUri
    && facts.activityObjectUri === facts.principalUri
    && facts.isLocalPrincipal === true
    && facts.principalSuspended === true
    && facts.isSystemPrincipal === false
    && facts.hasSigningKey === true;
}

export interface NotificationOwnershipFacts {
  notificationRecipientAccountId: string | null;
  userAccountId: string | null;
  userDisabled: boolean | null;
  userApproved: boolean | null;
  recipientSuspended: boolean | null;
  recipientMemorial: boolean | null;
}

export function notificationBelongsToUser(
  facts: NotificationOwnershipFacts,
): boolean {
  return isPresentIdentifier(facts.notificationRecipientAccountId)
    && isPresentIdentifier(facts.userAccountId)
    && facts.notificationRecipientAccountId === facts.userAccountId
    && canActAsAccount({
      accountSuspended: facts.recipientSuspended,
      userDisabled: facts.userDisabled,
      userApproved: facts.userApproved,
      memorial: facts.recipientMemorial,
    });
}

export type OwnedStatusMutation =
  | 'delete'
  | 'edit'
  | 'pin'
  | 'source'
  | 'unpin';

export interface OwnedStatusMutationFacts {
  actorAccountId: string | null;
  authorAccountId: string | null;
  statusDeleted: boolean | null;
  statusLocal: boolean | null;
  reblogOfStatusId: string | null;
  visibility: string | null;
}

/**
 * Canonical policy for mutations that require ownership of a local status.
 * Reblog wrappers have their own Undo path and must never be converted into a
 * Note by editing. Unpin intentionally accepts legacy invalid pin states so
 * their owner can clean them up.
 */
export function canMutateOwnedStatus(
  facts: OwnedStatusMutationFacts,
  mutation: OwnedStatusMutation,
): boolean {
  const ownedLocalStatus = isPresentIdentifier(facts.actorAccountId)
    && isPresentIdentifier(facts.authorAccountId)
    && facts.actorAccountId === facts.authorAccountId
    && facts.statusDeleted === false
    && facts.statusLocal === true;
  if (!ownedLocalStatus) return false;

  switch (mutation) {
    case 'delete':
    case 'unpin':
      return true;
    case 'edit':
    case 'source':
      return facts.reblogOfStatusId === null;
    case 'pin': {
      const visibility = parseStatusVisibility(facts.visibility);
      return facts.reblogOfStatusId === null
        && visibility !== null
        && visibility !== 'direct';
    }
  }
}

export interface MediaAttachmentMutationFacts {
  actorAccountId: string | null;
  mediaOwnerAccountId: string | null;
  mediaStatusId: string | null;
  targetStatusId: string | null;
}

/** Unattached media, or media already on the target, may be attached. */
export function canAttachMediaToStatus(
  facts: MediaAttachmentMutationFacts,
): boolean {
  return isPresentIdentifier(facts.actorAccountId)
    && isPresentIdentifier(facts.mediaOwnerAccountId)
    && isPresentIdentifier(facts.targetStatusId)
    && facts.actorAccountId === facts.mediaOwnerAccountId
    && (facts.mediaStatusId === null || facts.mediaStatusId === facts.targetStatusId);
}

export interface PollVotePermissionFacts {
  actorOperational: boolean | null;
  statusViewable: boolean;
  pollExpired: boolean | null;
}

export function canVoteInPoll(facts: PollVotePermissionFacts): boolean {
  return facts.actorOperational === true
    && facts.statusViewable
    && facts.pollExpired === false;
}

export interface StatusCreationPermissionFacts {
  actorOperational: boolean | null;
  actorIsLocal: boolean | null;
  actorMoved: boolean | null;
  actorSilenced: boolean | null;
  requestedVisibility: string | null;
}

/**
 * Resolves the visibility a local account may publish. Limited accounts keep
 * posting access, but public requests are deliberately downgraded to unlisted.
 */
export function resolveStatusCreationVisibility(
  facts: StatusCreationPermissionFacts,
): StatusVisibility | null {
  const requestedVisibility = parseStatusVisibility(facts.requestedVisibility);
  if (
    !requestedVisibility
    || facts.actorOperational !== true
    || facts.actorIsLocal !== true
    || facts.actorMoved !== false
    || facts.actorSilenced === null
  ) {
    return null;
  }

  return facts.actorSilenced && requestedVisibility === 'public'
    ? 'unlisted'
    : requestedVisibility;
}
