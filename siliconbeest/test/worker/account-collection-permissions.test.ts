import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  canViewAccountCollection,
  shouldHideRemoteAccountCollections,
} from '../../../packages/shared/permissions';
import { setupFollowersDispatcher } from '../../../packages/shared/federation/collection-dispatchers';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
type AccountPayload = { id: string };
type CredentialPayload = {
  source: { hide_collections: boolean };
};
type FollowersPage = {
  items: Array<{ id: URL }>;
  nextCursor: string | null;
};
type FollowersHandler = (
  ctx: { data: Record<string, never> },
  identifier: string,
  cursor: string | null,
) => Promise<FollowersPage | null>;

describe('account collection permission policy', () => {
  it('keeps collections public by default and fails closed for hidden or unknown state', () => {
    expect(canViewAccountCollection({
      ownerAccountId: 'owner',
      viewerAccountId: null,
      collectionsHidden: false,
    })).toBe(true);
    expect(canViewAccountCollection({
      ownerAccountId: 'owner',
      viewerAccountId: 'viewer',
      collectionsHidden: true,
    })).toBe(false);
    expect(canViewAccountCollection({
      ownerAccountId: 'owner',
      viewerAccountId: 'owner',
      collectionsHidden: true,
    })).toBe(true);
    expect(canViewAccountCollection({
      ownerAccountId: 'owner',
      viewerAccountId: null,
      collectionsHidden: null,
    })).toBe(false);
  });

  it('requires both remote collections to advertise a public first page', () => {
    expect(shouldHideRemoteAccountCollections({
      followersAdvertised: true,
      followingAdvertised: true,
      followersFirstPageAvailable: true,
      followingFirstPageAvailable: true,
    })).toBe(false);
    expect(shouldHideRemoteAccountCollections({
      followersAdvertised: true,
      followingAdvertised: true,
      followersFirstPageAvailable: false,
      followingFirstPageAvailable: true,
    })).toBe(true);
    expect(shouldHideRemoteAccountCollections({
      followersAdvertised: false,
      followingAdvertised: true,
      followersFirstPageAvailable: false,
      followingFirstPageAvailable: true,
    })).toBe(true);
  });
});

describe('followers and following collection privacy', () => {
  let owner: TestUser;
  let viewer: TestUser;
  let followed: TestUser;
  let writeOnly: TestUser;

  beforeAll(async () => {
    await applyMigration();
    owner = await createTestUser('collectionowner');
    viewer = await createTestUser('collectionviewer');
    followed = await createTestUser('collectionfollowed');
    writeOnly = await createTestUser('collectionwriteonly', {
      scopes: 'write:accounts',
    });
    const now = new Date().toISOString();
    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare(
        `INSERT INTO follows
          (id, account_id, target_account_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)`,
      ).bind(crypto.randomUUID(), viewer.accountId, owner.accountId, now),
      env.DB_META_C000.prepare(
        `INSERT INTO follows
          (id, account_id, target_account_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)`,
      ).bind(crypto.randomUUID(), owner.accountId, followed.accountId, now),
    ]);
  });

  it('preserves the existing public default', async () => {
    const followers = await SELF.fetch(
      `${BASE}/api/v1/accounts/${owner.accountId}/followers`,
    );
    const following = await SELF.fetch(
      `${BASE}/api/v1/accounts/${owner.accountId}/following`,
    );

    expect(followers.status).toBe(200);
    expect(following.status).toBe(200);
    expect((await followers.json<AccountPayload[]>()).map((item) => item.id))
      .toContain(viewer.accountId);
    expect((await following.json<AccountPayload[]>()).map((item) => item.id))
      .toContain(followed.accountId);
  });

  it('rejects an authenticated token without account read scope', async () => {
    const response = await SELF.fetch(
      `${BASE}/api/v1/accounts/${owner.accountId}/followers`,
      { headers: authHeaders(writeOnly.token) },
    );
    expect(response.status).toBe(403);
  });

  it('lets a local owner hide both collections while retaining owner access', async () => {
    const update = await SELF.fetch(`${BASE}/api/v1/accounts/update_credentials`, {
      method: 'PATCH',
      headers: authHeaders(owner.token),
      body: JSON.stringify({ hide_collections: true }),
    });
    expect(update.status).toBe(200);
    expect((await update.json<CredentialPayload>()).source.hide_collections).toBe(true);

    for (const collection of ['followers', 'following'] as const) {
      const anonymous = await SELF.fetch(
        `${BASE}/api/v1/accounts/${owner.accountId}/${collection}`,
      );
      const otherUser = await SELF.fetch(
        `${BASE}/api/v1/accounts/${owner.accountId}/${collection}`,
        { headers: authHeaders(viewer.token) },
      );
      const ownerRequest = await SELF.fetch(
        `${BASE}/api/v1/accounts/${owner.accountId}/${collection}`,
        { headers: authHeaders(owner.token) },
      );

      expect(anonymous.status).toBe(200);
      expect(await anonymous.json<AccountPayload[]>()).toEqual([]);
      expect(otherUser.status).toBe(200);
      expect(await otherUser.json<AccountPayload[]>()).toEqual([]);
      expect(ownerRequest.status).toBe(200);
      expect((await ownerRequest.json<AccountPayload[]>()).length).toBeGreaterThan(0);
    }

    const verified = await SELF.fetch(`${BASE}/api/v1/accounts/verify_credentials`, {
      headers: authHeaders(owner.token),
    });
    expect(verified.status).toBe(200);
    expect((await verified.json<CredentialPayload>()).source.hide_collections).toBe(true);
  });

  it('keeps Actor addressing intact but denies unsigned HTTP collection reads', async () => {
    const actor = await SELF.fetch(`${BASE}/users/collectionowner`, {
      headers: { Accept: 'application/activity+json' },
    });
    expect(actor.status).toBe(200);
    const actorBody = await actor.json<Record<string, unknown>>();
    expect(actorBody.followers).toBe(`${BASE}/users/collectionowner/followers`);
    expect(actorBody.following).toBe(`${BASE}/users/collectionowner/following`);

    for (const collection of ['followers', 'following'] as const) {
      const response = await SELF.fetch(
        `${BASE}/users/collectionowner/${collection}`,
        { headers: { Accept: 'application/activity+json' } },
      );
      expect(response.status).toBe(401);
    }
  });

  it('keeps internal followers expansion available for private-post delivery', async () => {
    const capture: { handler?: FollowersHandler } = {};
    const builder = {
      setCounter: () => builder,
      setFirstCursor: () => builder,
      authorize: () => builder,
    };
    const federation = {
      setFollowersDispatcher: (_path: string, handler: FollowersHandler) => {
        capture.handler = handler;
        return builder;
      },
    };
    setupFollowersDispatcher(federation);
    if (!capture.handler) throw new Error('Followers dispatcher was not registered');

    const page = await capture.handler({ data: {} }, 'collectionowner', null);
    expect(page?.items.map((item) => item.id.href))
      .toContain(`${BASE}/users/collectionviewer`);
  });

  it('restores public collection access when the owner opts back in', async () => {
    const update = await SELF.fetch(`${BASE}/api/v1/accounts/update_credentials`, {
      method: 'PATCH',
      headers: authHeaders(owner.token),
      body: JSON.stringify({ hide_collections: false }),
    });
    expect(update.status).toBe(200);
    expect((await update.json<CredentialPayload>()).source.hide_collections).toBe(false);

    const followers = await SELF.fetch(
      `${BASE}/api/v1/accounts/${owner.accountId}/followers`,
    );
    expect((await followers.json<AccountPayload[]>()).map((item) => item.id))
      .toContain(viewer.accountId);
  });
});
