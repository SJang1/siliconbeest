import { describe, expect, it } from 'vitest';
import {
  areOAuthScopesAllowed,
  areActivityPubUrisEquivalent,
  canFanOutStatus,
  canAddAccountToList,
  canActAsAccount,
  canAcceptFederatedReport,
  canApplyQuoteResponse,
  canApplyFederatedActorUpdate,
  canApplyFederatedDelete,
  canApplyFederatedResponse,
  canDeliverNotification,
  canEmbedQuote,
  canExposeStatusInActivityPubPublicCollection,
  canInteractWithStatus,
  canModerateAccount,
  canMutateOwnedFederatedResource,
  canOriginateAccountActivity,
  canOriginateNotification,
  canProcessFollowRequest,
  canProcessFederatedAccountTarget,
  canProcessFederatedMove,
  canRefollowAfterFederatedMove,
  canReceiveFederatedFollow,
  canUndoFederatedAccountAction,
  canQuoteStatus,
  canReblogStatus,
  canSignActivity,
  canStoreFetchedRemoteStatus,
  canAccessStreamingChannel,
  canSurfaceStatus,
  canViewStatus,
  constrainQuoteVisibility,
  getInternalSessionOAuthScopes,
  hasOAuthScope,
  hasStaffCapability,
  isPublicTimelineEligible,
  notificationBelongsToUser,
  parseStatusVisibility,
  parseUserRole,
  type StatusViewFacts,
} from '../../../packages/shared/permissions';

function statusFacts(overrides: Partial<StatusViewFacts> = {}): StatusViewFacts {
  return {
    visibility: 'public',
    viewerAccountId: null,
    authorAccountId: 'author',
    viewerFollowsAuthor: false,
    viewerIsMentioned: false,
    authorBlocksViewer: false,
    statusDeleted: false,
    ...overrides,
  };
}

describe('shared permission policy', () => {
  describe('directly fetched remote status identity', () => {
    const canonical = 'https://articles.example/ap/articles/123';
    const permalink = 'https://articles.example/@author/2026/article';
    const allowed = {
      requestedStatusUri: canonical,
      statusUri: canonical,
      authorUri: 'https://articles.example/ap/actors/author',
      localInstanceDomain: 'local.example',
      authorSuspended: false,
    } as const;

    it('accepts the canonical AP id and an explicitly advertised same-host permalink', () => {
      expect(canStoreFetchedRemoteStatus(allowed)).toBe(true);
      expect(canStoreFetchedRemoteStatus({
        ...allowed,
        requestedStatusUri: permalink,
        statusUrlAliases: [permalink],
      })).toBe(true);
    });

    it('rejects unadvertised, cross-host, and mismatched-author aliases', () => {
      expect(canStoreFetchedRemoteStatus({
        ...allowed,
        requestedStatusUri: permalink,
      })).toBe(false);
      expect(canStoreFetchedRemoteStatus({
        ...allowed,
        requestedStatusUri: 'https://other.example/@author/2026/article',
        statusUrlAliases: ['https://other.example/@author/2026/article'],
      })).toBe(false);
      expect(canStoreFetchedRemoteStatus({
        ...allowed,
        requestedStatusUri: permalink,
        statusUrlAliases: [permalink],
        authorUri: 'https://attacker.example/users/author',
      })).toBe(false);
    });
  });

  describe('status visibility parsing', () => {
    it.each(['public', 'unlisted', 'private', 'direct'] as const)(
      'accepts %s',
      (visibility) => {
        expect(parseStatusVisibility(visibility)).toBe(visibility);
      },
    );

    it.each([null, undefined, '', 'followers', 'PUBLIC'])(
      'rejects invalid value %s',
      (visibility) => {
        expect(parseStatusVisibility(visibility)).toBeNull();
      },
    );
  });

  describe('ActivityPub public collection visibility', () => {
    it.each(['public', 'unlisted'])(
      'allows an active author to expose a non-deleted %s status',
      (visibility) => {
        expect(canExposeStatusInActivityPubPublicCollection({
          visibility,
          statusDeleted: false,
          authorAvailable: true,
        })).toBe(true);
      },
    );

    it.each([
      ['private visibility', 'private', false, true],
      ['direct visibility', 'direct', false, true],
      ['deleted status', 'public', true, true],
      ['inactive author', 'public', false, false],
      ['unknown author state', 'public', false, null],
    ] satisfies [string, string, boolean, boolean | null][])(
      'rejects %s',
      (_label, visibility, statusDeleted, authorAvailable) => {
        expect(canExposeStatusInActivityPubPublicCollection({
          visibility,
          statusDeleted,
          authorAvailable,
        })).toBe(false);
      },
    );
  });

  describe('federated report identity binding', () => {
    const allowed = {
      reporterAccountId: 'remote-reporter',
      targetAccountId: 'local-target',
      recipientAccountId: 'local-target',
      reporterOperational: true,
      reporterIsRemote: true,
      targetOperational: true,
      targetIsLocal: true,
      allStatusReferencesAuthorized: true,
    } as const;

    it('allows exact personal and shared inbox delivery', () => {
      expect(canAcceptFederatedReport(allowed)).toBe(true);
      expect(canAcceptFederatedReport({
        ...allowed,
        recipientAccountId: null,
      })).toBe(true);
    });

    it.each([
      { recipientAccountId: 'different-local-account' },
      { reporterOperational: false },
      { reporterIsRemote: false },
      { targetOperational: false },
      { targetIsLocal: false },
      { allStatusReferencesAuthorized: false },
      { reporterAccountId: 'local-target' },
    ])('rejects a mismatched or inactive report boundary', (override) => {
      expect(canAcceptFederatedReport({ ...allowed, ...override })).toBe(false);
    });
  });

  describe('status viewing', () => {
    it.each(['public', 'unlisted'] as const)(
      'allows anonymous viewing of %s statuses',
      (visibility) => {
        expect(canViewStatus(statusFacts({ visibility }))).toBe(true);
      },
    );

    it('hides public and unlisted statuses from a viewer blocked by the author', () => {
      for (const visibility of ['public', 'unlisted'] as const) {
        expect(canViewStatus(statusFacts({
          visibility,
          viewerAccountId: 'blocked-viewer',
          authorBlocksViewer: true,
        }))).toBe(false);
        expect(canViewStatus(statusFacts({
          visibility,
          viewerAccountId: 'unblocked-viewer',
          authorBlocksViewer: false,
        }))).toBe(true);
      }
      expect(canViewStatus(statusFacts({
        viewerAccountId: null,
        authorBlocksViewer: null,
      }))).toBe(true);
    });

    it('allows the author to view every valid visibility', () => {
      for (const visibility of ['public', 'unlisted', 'private', 'direct'] as const) {
        expect(canViewStatus(statusFacts({
          visibility,
          viewerAccountId: 'author',
        }))).toBe(true);
      }
    });

    it('allows private statuses to followers and explicitly mentioned viewers', () => {
      expect(canViewStatus(statusFacts({
        visibility: 'private',
        viewerAccountId: 'follower',
        viewerFollowsAuthor: true,
      }))).toBe(true);
      expect(canViewStatus(statusFacts({
        visibility: 'private',
        viewerAccountId: 'mentioned',
        viewerIsMentioned: true,
      }))).toBe(true);
      expect(canViewStatus(statusFacts({
        visibility: 'private',
        viewerAccountId: 'stranger',
      }))).toBe(false);
      expect(canViewStatus(statusFacts({
        visibility: 'private',
        viewerAccountId: 'viewer-followed-by-author',
        viewerFollowsAuthor: false,
      }))).toBe(false);
    });

    it('allows direct statuses only to exact-status mentions other than the author', () => {
      expect(canViewStatus(statusFacts({
        visibility: 'direct',
        viewerAccountId: 'mentioned',
        viewerIsMentioned: true,
      }))).toBe(true);
      expect(canViewStatus(statusFacts({
        visibility: 'direct',
        viewerAccountId: 'follower-not-mentioned',
        viewerFollowsAuthor: true,
      }))).toBe(false);
    });

    it('fails closed for deleted, invalid, or malformed resources', () => {
      expect(canViewStatus(statusFacts({ statusDeleted: true }))).toBe(false);
      expect(canViewStatus(statusFacts({ visibility: 'followers' }))).toBe(false);
      expect(canViewStatus(statusFacts({ visibility: null }))).toBe(false);
      expect(canViewStatus(statusFacts({ authorAccountId: null }))).toBe(false);
      expect(canViewStatus(statusFacts({ authorAccountId: '' }))).toBe(false);
    });
  });

  it('keeps public timeline and reblog rules distinct', () => {
    expect(isPublicTimelineEligible('public')).toBe(true);
    expect(isPublicTimelineEligible('unlisted')).toBe(false);
    expect(isPublicTimelineEligible('invalid')).toBe(false);
    expect(canReblogStatus('public')).toBe(true);
    expect(canReblogStatus('unlisted')).toBe(true);
    expect(canReblogStatus('private')).toBe(false);
    expect(canReblogStatus('direct')).toBe(false);
    expect(canReblogStatus(null)).toBe(false);
  });

  describe('staff capabilities', () => {
    it('parses only supported roles', () => {
      expect(parseUserRole('user')).toBe('user');
      expect(parseUserRole('moderator')).toBe('moderator');
      expect(parseUserRole('admin')).toBe('admin');
      expect(parseUserRole('owner')).toBeNull();
      expect(parseUserRole(null)).toBeNull();
    });

    it('allows moderators to moderate but not manage roles or the instance', () => {
      expect(hasStaffCapability('moderator', 'moderation:read')).toBe(true);
      expect(hasStaffCapability('moderator', 'accounts:moderate')).toBe(true);
      expect(hasStaffCapability('moderator', 'roles:manage')).toBe(false);
      expect(hasStaffCapability('moderator', 'instance:manage')).toBe(false);
    });

    it('allows admins every staff capability and fails closed for other roles', () => {
      expect(hasStaffCapability('admin', 'roles:manage')).toBe(true);
      expect(hasStaffCapability('admin', 'instance:manage')).toBe(true);
      expect(hasStaffCapability('user', 'moderation:read')).toBe(false);
      expect(hasStaffCapability('owner', 'moderation:read')).toBe(false);
      expect(hasStaffCapability(null, 'moderation:read')).toBe(false);
    });

    it('prevents self-moderation and enforces the staff hierarchy', () => {
      expect(canModerateAccount({
        actorRole: 'moderator',
        actorAccountId: 'moderator',
        targetRole: 'user',
        targetAccountId: 'user',
      })).toBe(true);
      expect(canModerateAccount({
        actorRole: 'moderator',
        actorAccountId: 'moderator',
        targetRole: 'admin',
        targetAccountId: 'admin',
      })).toBe(false);
      expect(canModerateAccount({
        actorRole: 'admin',
        actorAccountId: 'admin-one',
        targetRole: 'admin',
        targetAccountId: 'admin-two',
      })).toBe(true);
      expect(canModerateAccount({
        actorRole: 'admin',
        actorAccountId: 'admin',
        targetRole: 'user',
        targetAccountId: 'admin',
      })).toBe(false);
      expect(canModerateAccount({
        actorRole: 'owner',
        actorAccountId: 'owner',
        targetRole: 'user',
        targetAccountId: 'user',
      })).toBe(false);
    });
  });

  describe('OAuth scopes', () => {
    it('supports direct, hierarchical, legacy follow, and granular admin grants', () => {
      expect(hasOAuthScope('read:accounts', 'read:accounts')).toBe(true);
      expect(hasOAuthScope('read', 'read:statuses')).toBe(true);
      expect(hasOAuthScope('follow', 'write:blocks')).toBe(true);
      expect(hasOAuthScope('admin:read', 'admin:read:accounts')).toBe(true);
      expect(hasOAuthScope('admin:write', 'admin:write:reports')).toBe(true);
    });

    it('inherits every documented granular scope from its broad parent', () => {
      const scopeFamilies = {
        read: [
          'read:accounts', 'read:blocks', 'read:bookmarks', 'read:collections',
          'read:favourites', 'read:filters', 'read:follows', 'read:lists',
          'read:mutes', 'read:notifications', 'read:search', 'read:statuses',
        ],
        write: [
          'write:accounts', 'write:blocks', 'write:bookmarks', 'write:collections',
          'write:conversations', 'write:favourites', 'write:filters', 'write:follows',
          'write:lists', 'write:media', 'write:mutes', 'write:notifications',
          'write:reports', 'write:statuses',
        ],
        'admin:read': [
          'admin:read:accounts', 'admin:read:canonical_email_blocks',
          'admin:read:domain_allows', 'admin:read:domain_blocks',
          'admin:read:email_domain_blocks', 'admin:read:ip_blocks',
          'admin:read:reports',
        ],
        'admin:write': [
          'admin:write:accounts', 'admin:write:canonical_email_blocks',
          'admin:write:domain_allows', 'admin:write:domain_blocks',
          'admin:write:email_domain_blocks', 'admin:write:ip_blocks',
          'admin:write:reports',
        ],
      } as const;

      for (const [parent, granularScopes] of Object.entries(scopeFamilies)) {
        for (const granular of granularScopes) {
          expect(hasOAuthScope(parent, granular), `${parent} should grant ${granular}`)
            .toBe(true);
          expect(areOAuthScopesAllowed(parent, granular))
            .toBe(true);
        }
      }
    });

    it('fails closed for missing or unrelated grants', () => {
      expect(hasOAuthScope(null, 'read:statuses')).toBe(false);
      expect(hasOAuthScope('', 'read:statuses')).toBe(false);
      expect(hasOAuthScope('read:accounts', 'read:statuses')).toBe(false);
      expect(hasOAuthScope('follow', 'write:statuses')).toBe(false);
      expect(hasOAuthScope('admin:read', 'admin:write')).toBe(false);
      expect(hasOAuthScope('admin:read:accounts', 'admin:read:reports')).toBe(false);
      expect(hasOAuthScope('admin', 'admin:write')).toBe(false);
      expect(hasOAuthScope('read', 'admin:read:accounts')).toBe(false);
			expect(hasOAuthScope('read', 'read:unknown')).toBe(false);
			expect(hasOAuthScope('write', 'write:unknown')).toBe(false);
			expect(hasOAuthScope('admin:read', 'admin:read:unknown')).toBe(false);
    });

    it('prevents requested scopes from exceeding an application registration', () => {
      expect(areOAuthScopesAllowed('read write:statuses', 'read:accounts write:statuses'))
        .toBe(true);
      expect(areOAuthScopesAllowed('read:accounts', 'read')).toBe(false);
      expect(areOAuthScopesAllowed('read write', 'admin:read:accounts')).toBe(false);
      expect(areOAuthScopesAllowed('admin:read', 'admin:read:reports')).toBe(true);
      expect(areOAuthScopesAllowed('read', '')).toBe(false);
    });

    it('adds admin scopes only to built-in staff sessions', () => {
      expect(getInternalSessionOAuthScopes('user')).toBe('read write follow push');
      expect(getInternalSessionOAuthScopes('invalid')).toBe('read write follow push');
      expect(getInternalSessionOAuthScopes('moderator'))
        .toBe('read write follow push admin:read admin:write');
      expect(getInternalSessionOAuthScopes('admin'))
        .toBe('read write follow push admin:read admin:write');
    });

		it('requires channel-specific streaming scopes', () => {
			expect(canAccessStreamingChannel('read:statuses', 'public')).toBe(true);
			expect(canAccessStreamingChannel('read:statuses', 'direct')).toBe(true);
			expect(canAccessStreamingChannel('read:statuses', 'user')).toBe(false);
			expect(canAccessStreamingChannel(
				'read:statuses read:notifications',
				'user',
			)).toBe(true);
			expect(canAccessStreamingChannel('read:notifications', 'user:notification')).toBe(false);
			expect(canAccessStreamingChannel('read', 'user:notification')).toBe(true);
			expect(canAccessStreamingChannel('read', 'arbitrary')).toBe(false);
		});
  });

  describe('account state and surface suppression', () => {
		it('requires active unblocked requesters and followed list members', () => {
			const remoteOperational = {
				accountSuspended: false,
				accountMemorial: false,
				isLocalAccount: false,
				userDisabled: null,
				userApproved: null,
			} as const;
			const request = {
				requesterAccountId: 'requester',
				targetAccountId: 'target',
				requesterOperational: remoteOperational,
				requesterBlocksTarget: false,
				targetBlocksRequester: false,
				targetBlocksRequesterDomain: false,
			} as const;
			expect(canProcessFollowRequest(request)).toBe(true);
			expect(canProcessFollowRequest({ ...request, targetBlocksRequester: true })).toBe(false);
			expect(canProcessFollowRequest({
				...request,
				targetBlocksRequesterDomain: true,
			})).toBe(false);
			expect(canProcessFollowRequest({
				...request,
				requesterOperational: { ...remoteOperational, accountSuspended: true },
			})).toBe(false);

			const incomingFollow = {
				...request,
				recipientAccountId: 'target',
				requesterIsRemote: true,
				targetIsLocal: true,
				targetMoved: false,
				targetOperational: {
					accountSuspended: false,
					userDisabled: false,
					userApproved: true,
					memorial: false,
				},
			} as const;
			expect(canReceiveFederatedFollow(incomingFollow)).toBe(true);
			expect(canReceiveFederatedFollow({
				...incomingFollow,
				recipientAccountId: 'other-target',
			})).toBe(false);

			const accountTarget = {
				actorAccountId: 'remote-actor',
				targetAccountId: 'local-target',
				recipientAccountId: 'local-target',
				actorOperational: remoteOperational,
				actorIsRemote: true,
				targetIsLocal: true,
			} as const;
			expect(canProcessFederatedAccountTarget(accountTarget)).toBe(true);
			expect(canProcessFederatedAccountTarget({
				...accountTarget,
				recipientAccountId: 'other-target',
			})).toBe(false);
			expect(canProcessFederatedAccountTarget({
				...accountTarget,
				actorIsRemote: false,
			})).toBe(false);
			expect(canReceiveFederatedFollow({
				...incomingFollow,
				targetMoved: true,
			})).toBe(false);
			expect(canReceiveFederatedFollow({
				...incomingFollow,
				targetOperational: {
					...incomingFollow.targetOperational,
					userDisabled: true,
				},
			})).toBe(false);

			const listMember = {
				actorAccountId: 'owner',
				listOwnerAccountId: 'owner',
				memberAccountId: 'member',
				memberOperational: remoteOperational,
				actorFollowsMember: true,
				actorBlocksMember: false,
				memberBlocksActor: false,
			} as const;
			expect(canAddAccountToList(listMember)).toBe(true);
			expect(canAddAccountToList({ ...listMember, actorFollowsMember: false })).toBe(false);
			expect(canAddAccountToList({ ...listMember, listOwnerAccountId: 'other' })).toBe(false);
		});

    it('centralizes owned remote Update and cleanup Delete semantics', () => {
      const remoteOperational = {
        accountSuspended: false,
        accountMemorial: false,
        isLocalAccount: false,
        userDisabled: null,
        userApproved: null,
      } as const;
      const update = {
        actorAccountId: 'remote-owner',
        ownerAccountId: 'remote-owner',
        actorIsRemote: true,
        actorOperational: remoteOperational,
      } as const;
      expect(canApplyFederatedActorUpdate(update)).toBe(true);
      expect(canApplyFederatedActorUpdate({
        ...update,
        actorOperational: { ...remoteOperational, accountSuspended: true },
      })).toBe(false);
      expect(canApplyFederatedActorUpdate({ ...update, ownerAccountId: 'victim' })).toBe(false);
      expect(canApplyFederatedActorUpdate({ ...update, actorIsRemote: false })).toBe(false);

      expect(canApplyFederatedDelete({
        actorAccountId: 'suspended-remote',
        ownerAccountId: 'suspended-remote',
        actorIsRemote: true,
      })).toBe(true);
      expect(canApplyFederatedDelete({
        actorAccountId: 'local',
        ownerAccountId: 'local',
        actorIsRemote: false,
      })).toBe(false);
    });

    it('binds account Undo to its embedded actor, stored target, and inbox', () => {
      const remoteOperational = {
        accountSuspended: false,
        accountMemorial: false,
        isLocalAccount: false,
        userDisabled: null,
        userApproved: null,
      } as const;
      const undo = {
        actorAccountId: 'remote',
        targetAccountId: 'local-target',
        recipientAccountId: 'local-target',
        actorOperational: remoteOperational,
        actorIsRemote: true,
        targetIsLocal: true,
        embeddedActorMatches: true,
        storedTargetMatches: true,
      } as const;
      expect(canUndoFederatedAccountAction(undo)).toBe(true);
      expect(canUndoFederatedAccountAction({ ...undo, embeddedActorMatches: false })).toBe(false);
      expect(canUndoFederatedAccountAction({ ...undo, storedTargetMatches: false })).toBe(false);
      expect(canUndoFederatedAccountAction({
        ...undo,
        recipientAccountId: 'other-local-account',
      })).toBe(false);
    });

    it('allows only verified idempotent Move and eligible per-follower re-follow', () => {
      const remoteOperational = {
        accountSuspended: false,
        accountMemorial: false,
        isLocalAccount: false,
        userDisabled: null,
        userApproved: null,
      } as const;
      const localOperational = {
        accountSuspended: false,
        userDisabled: false,
        userApproved: true,
        memorial: false,
      } as const;
      const move = {
        actorAccountId: 'old',
        oldAccountId: 'old',
        newAccountId: 'new',
        recipientAccountId: 'follower',
        actorIsRemote: true,
        actorOperational: remoteOperational,
        newAccountOperational: remoteOperational,
        newAccountMoved: false,
        newAccountAliasesOld: true,
        oldMovedToAccountId: null,
        recipientIsLocal: true,
        recipientFollowsOld: true,
        recipientOperational: localOperational,
      } as const;
      expect(canProcessFederatedMove(move)).toBe(true);
      expect(canProcessFederatedMove({ ...move, oldMovedToAccountId: 'new' })).toBe(true);
      expect(canProcessFederatedMove({ ...move, oldMovedToAccountId: 'other' })).toBe(false);
      expect(canProcessFederatedMove({ ...move, newAccountAliasesOld: false })).toBe(false);
      expect(canProcessFederatedMove({ ...move, recipientFollowsOld: false })).toBe(false);
      expect(canProcessFederatedMove({ ...move, newAccountMoved: true })).toBe(false);
      expect(canProcessFederatedMove({
        ...move,
        newAccountOperational: { ...remoteOperational, accountSuspended: true },
      })).toBe(false);
      expect(canProcessFederatedMove({
        ...move,
        recipientAccountId: null,
        recipientIsLocal: null,
        recipientFollowsOld: null,
        recipientOperational: null,
      })).toBe(true);

      const refollow = {
        followerAccountId: 'follower',
        oldAccountId: 'old',
        newAccountId: 'new',
        followerOperational: {
          accountSuspended: false,
          accountMemorial: false,
          isLocalAccount: true,
          userDisabled: false,
          userApproved: true,
        },
        followsOld: true,
        alreadyFollowsNew: false,
        alreadyRequestedNew: false,
        followerBlocksNew: false,
        followerBlocksNewDomain: false,
        newBlocksFollower: false,
      } as const;
      expect(canRefollowAfterFederatedMove(refollow)).toBe(true);
      expect(canRefollowAfterFederatedMove({ ...refollow, alreadyRequestedNew: true })).toBe(false);
      expect(canRefollowAfterFederatedMove({ ...refollow, followerBlocksNew: true })).toBe(false);
      expect(canRefollowAfterFederatedMove({ ...refollow, followerBlocksNewDomain: true })).toBe(false);
      expect(canRefollowAfterFederatedMove({ ...refollow, newBlocksFollower: true })).toBe(false);
    });

    it('normalizes only the URI host while preserving path identity', () => {
      expect(areActivityPubUrisEquivalent(
        'https://REMOTE.EXAMPLE/users/Alice',
        'https://remote.example/users/Alice',
      )).toBe(true);
      expect(areActivityPubUrisEquivalent(
        'https://remote.example/users/Alice',
        'https://remote.example/users/alice',
      )).toBe(false);
      expect(areActivityPubUrisEquivalent('javascript:alert(1)', 'javascript:alert(1)')).toBe(false);
    });

    it('allows account actions only when every operational state is explicitly clear', () => {
      expect(canActAsAccount({
        accountSuspended: false,
        userDisabled: false,
        userApproved: true,
        memorial: false,
      })).toBe(true);
      for (const facts of [
        { accountSuspended: true, userDisabled: false, userApproved: true, memorial: false },
        { accountSuspended: false, userDisabled: true, userApproved: true, memorial: false },
        { accountSuspended: false, userDisabled: false, userApproved: false, memorial: false },
        { accountSuspended: false, userDisabled: false, userApproved: true, memorial: true },
        { accountSuspended: null, userDisabled: false, userApproved: true, memorial: false },
      ]) {
        expect(canActAsAccount(facts)).toBe(false);
      }
    });

    it('allows status interaction only when the actor is active and can view it', () => {
      const allowed = {
        statusViewable: true,
        actorSuspended: false,
        actorBlocksAuthor: false,
        actorBlocksAuthorDomain: false,
      } as const;
      expect(canInteractWithStatus(allowed)).toBe(true);
      expect(canInteractWithStatus({ ...allowed, statusViewable: false })).toBe(false);
      expect(canInteractWithStatus({ ...allowed, actorSuspended: true })).toBe(false);
      expect(canInteractWithStatus({ ...allowed, actorSuspended: null })).toBe(false);
      expect(canInteractWithStatus({ ...allowed, actorBlocksAuthor: true })).toBe(false);
      expect(canInteractWithStatus({ ...allowed, actorBlocksAuthor: null })).toBe(false);
      expect(canInteractWithStatus({ ...allowed, actorBlocksAuthorDomain: true })).toBe(false);
      expect(canInteractWithStatus({ ...allowed, actorBlocksAuthorDomain: null })).toBe(false);
    });

    it('requires operational remote and local actors to originate activities', () => {
      expect(canOriginateAccountActivity({
        accountSuspended: false,
        accountMemorial: false,
        isLocalAccount: false,
        userDisabled: null,
        userApproved: null,
      })).toBe(true);
      expect(canOriginateAccountActivity({
        accountSuspended: false,
        accountMemorial: false,
        isLocalAccount: true,
        userDisabled: false,
        userApproved: true,
      })).toBe(true);
      expect(canOriginateAccountActivity({
        accountSuspended: false,
        accountMemorial: true,
        isLocalAccount: false,
        userDisabled: null,
        userApproved: null,
      })).toBe(false);
      expect(canOriginateAccountActivity({
        accountSuspended: false,
        accountMemorial: false,
        isLocalAccount: true,
        userDisabled: true,
        userApproved: true,
      })).toBe(false);
    });

    it('applies visibility and public/followers/nobody quote policy fail closed', () => {
      const base = {
        statusViewable: true,
        statusVisibility: 'public',
        quotePolicy: 'public',
        requesterIsAuthor: false,
        requesterFollowsAuthor: false,
        requesterBlocksAuthor: false,
        requesterBlocksAuthorDomain: false,
      } as const;
      expect(canQuoteStatus(base)).toBe(true);
      expect(canQuoteStatus({ ...base, quotePolicy: 'followers' })).toBe(false);
      expect(canQuoteStatus({
        ...base,
        quotePolicy: 'followers',
        requesterFollowsAuthor: true,
      })).toBe(true);
      expect(canQuoteStatus({ ...base, quotePolicy: 'nobody' })).toBe(false);
      expect(canQuoteStatus({
        ...base,
        statusVisibility: 'private',
        requesterIsAuthor: true,
        quotePolicy: 'nobody',
      })).toBe(true);
      expect(canQuoteStatus({
        ...base,
        statusVisibility: 'direct',
        requesterIsAuthor: true,
      })).toBe(false);
      expect(canQuoteStatus({ ...base, quotePolicy: 'unexpected' })).toBe(false);
      expect(canQuoteStatus({ ...base, statusViewable: false })).toBe(false);
      expect(canQuoteStatus({ ...base, requesterBlocksAuthor: true })).toBe(false);
      expect(canQuoteStatus({ ...base, requesterBlocksAuthorDomain: true })).toBe(false);

      const rawPolicy = {
        ...base,
        quotePolicy: 'nobody',
        requesterUri: 'https://requester.example/users/alice',
        authorUri: 'https://author.example/users/bob',
        automaticApprovalTargets: [] as string[],
        manualApprovalTargets: [] as string[],
      };
      expect(canQuoteStatus({
        ...rawPolicy,
        automaticApprovalTargets: ['https://requester.example/users/alice'],
      })).toBe(true);
      expect(canQuoteStatus({
        ...rawPolicy,
        manualApprovalTargets: ['https://requester.example/users/alice'],
      })).toBe(true);
      expect(canQuoteStatus({
        ...rawPolicy,
        automaticApprovalTargets: ['https://author.example/users/bob/followers'],
        requesterFollowsAuthor: true,
      })).toBe(true);
      expect(canQuoteStatus({
        ...rawPolicy,
        automaticApprovalTargets: ['https://author.example/users/bob/following'],
        authorFollowsRequester: true,
      })).toBe(true);
      expect(canQuoteStatus(rawPolicy)).toBe(false);
    });

    it('clamps private quote wrappers and embeds only accepted relationships', () => {
      expect(constrainQuoteVisibility('public', 'private')).toBe('private');
      expect(constrainQuoteVisibility('unlisted', 'private')).toBe('private');
      expect(constrainQuoteVisibility('direct', 'private')).toBe('direct');
      expect(constrainQuoteVisibility('public', 'unlisted')).toBe('public');
      expect(constrainQuoteVisibility('public', 'direct')).toBeNull();
      expect(constrainQuoteVisibility('circle', 'public')).toBeNull();

      expect(canEmbedQuote({
        quoteStatusId: 'quote',
        quoteApprovalStatus: 'accepted',
      })).toBe(true);
      for (const quoteApprovalStatus of ['none', 'pending', 'rejected', 'revoked', null]) {
        expect(canEmbedQuote({ quoteStatusId: 'quote', quoteApprovalStatus })).toBe(false);
      }
      expect(canEmbedQuote({
        quoteStatusId: null,
        quoteApprovalStatus: 'accepted',
      })).toBe(false);

      expect(canMutateOwnedFederatedResource({
        actorAccountId: 'quote-author',
        ownerAccountId: 'quote-author',
      })).toBe(true);
      expect(canMutateOwnedFederatedResource({
        actorAccountId: 'attacker',
        ownerAccountId: 'quote-author',
      })).toBe(false);
      expect(canApplyQuoteResponse({
        actorAccountId: 'target-author',
        ownerAccountId: 'target-author',
        localQuoteAuthorAccountId: 'local-author',
        recipientAccountId: 'local-author',
        quoteApprovalStatus: 'pending',
      })).toBe(true);
      expect(canApplyQuoteResponse({
        actorAccountId: 'attacker',
        ownerAccountId: 'target-author',
        localQuoteAuthorAccountId: 'local-author',
        recipientAccountId: 'local-author',
        quoteApprovalStatus: 'pending',
      })).toBe(false);
      expect(canApplyFederatedResponse({
        actorAccountId: 'remote-target',
        ownerAccountId: 'remote-target',
        localInitiatorAccountId: 'local-follower',
        recipientAccountId: 'local-follower',
        localInitiatorIsLocal: true,
        requestPending: true,
        embeddedInitiatorMatches: true,
        embeddedOwnerMatches: true,
      })).toBe(true);
      expect(canApplyFederatedResponse({
        actorAccountId: 'attacker',
        ownerAccountId: 'remote-target',
        localInitiatorAccountId: 'local-follower',
        recipientAccountId: 'local-follower',
        localInitiatorIsLocal: true,
        requestPending: true,
        embeddedInitiatorMatches: true,
        embeddedOwnerMatches: true,
      })).toBe(false);
      expect(canApplyFederatedResponse({
        actorAccountId: 'remote-target',
        ownerAccountId: 'remote-target',
        localInitiatorAccountId: 'local-follower',
        recipientAccountId: 'other-local-account',
        localInitiatorIsLocal: true,
        requestPending: true,
        embeddedInitiatorMatches: true,
        embeddedOwnerMatches: true,
      })).toBe(false);
      expect(canApplyQuoteResponse({
        actorAccountId: 'target-author',
        ownerAccountId: 'target-author',
        localQuoteAuthorAccountId: 'local-author',
        recipientAccountId: 'wrong-recipient',
        quoteApprovalStatus: 'pending',
      })).toBe(false);
    });

    it('keeps visibility separate from timeline relationship suppression', () => {
      expect(canSurfaceStatus({
        statusViewable: true,
        authorSuspended: false,
        authorSilenced: false,
        viewerIsAuthor: false,
        viewerFollowsAuthor: false,
        viewerMutesAuthor: false,
        viewerBlocksAuthor: false,
        viewerBlocksAuthorDomain: false,
        authorBlocksViewer: false,
      })).toBe(true);
      expect(canSurfaceStatus({
        statusViewable: true,
        authorSuspended: false,
        authorSilenced: false,
        viewerIsAuthor: false,
        viewerFollowsAuthor: false,
        viewerMutesAuthor: true,
        viewerBlocksAuthor: false,
        viewerBlocksAuthorDomain: false,
        authorBlocksViewer: false,
      })).toBe(false);
      expect(canSurfaceStatus({
        statusViewable: true,
        authorSuspended: false,
        authorSilenced: false,
        viewerIsAuthor: false,
        viewerFollowsAuthor: false,
        viewerMutesAuthor: false,
        viewerBlocksAuthor: false,
        viewerBlocksAuthorDomain: false,
        authorBlocksViewer: true,
      })).toBe(false);
      expect(canSurfaceStatus({
        statusViewable: true,
        authorSuspended: false,
        authorSilenced: true,
        viewerIsAuthor: false,
        viewerFollowsAuthor: false,
        viewerMutesAuthor: false,
        viewerBlocksAuthor: false,
        viewerBlocksAuthorDomain: false,
        authorBlocksViewer: false,
      })).toBe(false);
      expect(canSurfaceStatus({
        statusViewable: true,
        authorSuspended: false,
        authorSilenced: true,
        viewerIsAuthor: false,
        viewerFollowsAuthor: true,
        viewerMutesAuthor: false,
        viewerBlocksAuthor: false,
        viewerBlocksAuthorDomain: false,
        authorBlocksViewer: false,
      })).toBe(true);
      expect(canSurfaceStatus({
        statusViewable: true,
        authorSuspended: false,
        authorSilenced: false,
        viewerIsAuthor: false,
        viewerFollowsAuthor: false,
        viewerMutesAuthor: false,
        viewerBlocksAuthor: false,
        viewerBlocksAuthorDomain: true,
        authorBlocksViewer: false,
      })).toBe(false);
    });

    it('delivers notifications only to operational recipients without suppression', () => {
      const allowed = {
        recipientOperational: {
          accountSuspended: false,
          userDisabled: false,
          userApproved: true,
          memorial: false,
        },
        senderOperational: {
          accountSuspended: false,
          accountMemorial: false,
          isLocalAccount: true,
          userDisabled: false,
          userApproved: true,
        },
        viewerMutesSender: false,
        viewerBlocksSender: false,
        viewerBlocksSenderDomain: false,
        senderBlocksViewer: false,
        statusBearing: true,
        statusSurface: {
          statusViewable: true,
          authorSuspended: false,
          authorSilenced: false,
          viewerIsAuthor: false,
          viewerFollowsAuthor: false,
          viewerMutesAuthor: false,
          viewerBlocksAuthor: false,
          viewerBlocksAuthorDomain: false,
          authorBlocksViewer: false,
        },
        viewerMutesStatusThread: false,
      } as const;
      expect(canDeliverNotification(allowed)).toBe(true);
      expect(canDeliverNotification({
        ...allowed,
        statusSurface: { ...allowed.statusSurface, statusViewable: false },
      })).toBe(false);
      expect(canDeliverNotification({ ...allowed, viewerMutesStatusThread: true })).toBe(false);
      expect(canDeliverNotification({ ...allowed, senderBlocksViewer: true })).toBe(false);
      expect(canDeliverNotification({ ...allowed, viewerBlocksSenderDomain: true })).toBe(false);
      expect(canDeliverNotification({
        ...allowed,
        statusBearing: false,
        statusSurface: null,
        viewerMutesStatusThread: null,
      })).toBe(true);
      expect(canDeliverNotification({
        ...allowed,
        statusBearing: false,
        statusSurface: allowed.statusSurface,
        viewerMutesStatusThread: null,
      })).toBe(false);

      expect(canOriginateNotification({
        accountSuspended: false,
        accountMemorial: false,
        isLocalAccount: false,
        userDisabled: null,
        userApproved: null,
      })).toBe(true);
      expect(canOriginateNotification({
        accountSuspended: false,
        accountMemorial: false,
        isLocalAccount: true,
        userDisabled: false,
        userApproved: false,
      })).toBe(false);
    });
  });

  describe('queue boundary policies', () => {
    it('fans out only active, non-direct statuses attributed to the message account', () => {
      expect(canFanOutStatus({
        statusAccountId: 'author',
        messageAccountId: 'author',
        visibility: 'private',
        statusDeleted: false,
        authorSuspended: false,
      })).toBe(true);
      expect(canFanOutStatus({
        statusAccountId: 'author',
        messageAccountId: 'attacker',
        visibility: 'public',
        statusDeleted: false,
        authorSuspended: false,
      })).toBe(false);
      expect(canActAsAccount({
        accountSuspended: false,
        userDisabled: false,
        userApproved: true,
        memorial: false,
      })).toBe(true);
      expect(canActAsAccount({
        accountSuspended: null,
        userDisabled: false,
        userApproved: true,
        memorial: false,
      })).toBe(false);
      expect(canFanOutStatus({
        statusAccountId: 'author',
        messageAccountId: 'author',
        visibility: 'direct',
        statusDeleted: false,
        authorSuspended: false,
      })).toBe(false);
      expect(canFanOutStatus({
        statusAccountId: 'author',
        messageAccountId: 'author',
        visibility: 'invalid',
        statusDeleted: false,
        authorSuspended: false,
      })).toBe(false);
      expect(canFanOutStatus({
        statusAccountId: null,
        messageAccountId: 'author',
        visibility: 'public',
        statusDeleted: false,
        authorSuspended: false,
      })).toBe(false);
    });

    it('signs only an active local principal matching the activity actor', () => {
      expect(canSignActivity({
        principalUri: 'https://example.test/users/alice',
        activityActorUri: 'https://example.test/users/alice',
        isLocalPrincipal: true,
        principalSuspended: false,
        principalMemorial: false,
        principalUserDisabled: false,
        principalUserApproved: true,
        isSystemPrincipal: false,
        hasSigningKey: true,
      })).toBe(true);
      expect(canSignActivity({
        principalUri: 'https://example.test/users/alice',
        activityActorUri: 'https://example.test/users/mallory',
        isLocalPrincipal: true,
        principalSuspended: false,
        principalMemorial: false,
        principalUserDisabled: false,
        principalUserApproved: true,
        isSystemPrincipal: false,
        hasSigningKey: true,
      })).toBe(false);
      expect(canSignActivity({
        principalUri: null,
        activityActorUri: null,
        isLocalPrincipal: true,
        principalSuspended: false,
        principalMemorial: false,
        principalUserDisabled: false,
        principalUserApproved: true,
        isSystemPrincipal: false,
        hasSigningKey: true,
      })).toBe(false);
      expect(canSignActivity({
        principalUri: 'https://example.test/actor',
        activityActorUri: 'https://example.test/actor',
        isLocalPrincipal: true,
        principalSuspended: false,
        principalMemorial: false,
        principalUserDisabled: null,
        principalUserApproved: null,
        isSystemPrincipal: true,
        hasSigningKey: true,
      })).toBe(true);
      expect(canSignActivity({
        principalUri: 'https://example.test/users/alice',
        activityActorUri: 'https://example.test/users/alice',
        isLocalPrincipal: true,
        principalSuspended: false,
        principalMemorial: false,
        principalUserDisabled: null,
        principalUserApproved: null,
        isSystemPrincipal: false,
        hasSigningKey: true,
      })).toBe(false);
    });

    it('binds notifications to the active recipient user', () => {
      expect(notificationBelongsToUser({
        notificationRecipientAccountId: 'recipient',
        userAccountId: 'recipient',
        userDisabled: false,
        userApproved: true,
        recipientSuspended: false,
        recipientMemorial: false,
      })).toBe(true);
      expect(notificationBelongsToUser({
        notificationRecipientAccountId: 'recipient',
        userAccountId: 'attacker',
        userDisabled: false,
        userApproved: true,
        recipientSuspended: false,
        recipientMemorial: false,
      })).toBe(false);
      expect(notificationBelongsToUser({
        notificationRecipientAccountId: 'recipient',
        userAccountId: 'recipient',
        userDisabled: true,
        userApproved: true,
        recipientSuspended: false,
        recipientMemorial: false,
      })).toBe(false);
      expect(notificationBelongsToUser({
        notificationRecipientAccountId: null,
        userAccountId: 'recipient',
        userDisabled: false,
        userApproved: true,
        recipientSuspended: false,
        recipientMemorial: false,
      })).toBe(false);
      expect(notificationBelongsToUser({
        notificationRecipientAccountId: 'recipient',
        userAccountId: 'recipient',
        userDisabled: false,
        userApproved: true,
        recipientSuspended: false,
        recipientMemorial: true,
      })).toBe(false);
      expect(notificationBelongsToUser({
        notificationRecipientAccountId: 'recipient',
        userAccountId: 'recipient',
        userDisabled: false,
        userApproved: false,
        recipientSuspended: false,
        recipientMemorial: false,
      })).toBe(false);
    });
  });
});
