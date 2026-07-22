import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

type AccountEntity = {
  id: string;
  limited?: boolean;
  memorial?: boolean;
};

type SearchEntity = {
  accounts: AccountEntity[];
  statuses: Array<{ id: string }>;
};

type RelationshipEntity = {
  id: string;
  following: boolean;
  followed_by: boolean;
  endorsed: boolean;
};

describe('account API permissions', () => {
  let viewer: TestUser;
  let active: TestUser;
  let silenced: TestUser;
  let suspended: TestUser;
  let frozen: TestUser;
  let pendingApproval: TestUser;
  let memorial: TestUser;
  let moved: TestUser;
  let muted: TestUser;
  let reverseBlocked: TestUser;
  let mutedStatus: { id: string; uri: string };
  const localSystemAccountId = 'acctperm-system';

  beforeAll(async () => {
    await applyMigration();
    viewer = await createTestUser('acctpermviewer');
    active = await createTestUser('acctpermactive');
    silenced = await createTestUser('acctpermsilenced');
    suspended = await createTestUser('acctpermsuspended');
    frozen = await createTestUser('acctpermfrozen');
    pendingApproval = await createTestUser('acctpermpending');
    memorial = await createTestUser('acctpermmemorial');
    moved = await createTestUser('acctpermmoved');
    muted = await createTestUser('acctpermmuted');
    reverseBlocked = await createTestUser('acctpermreverseblock');

    const statusResponse = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(muted.token),
      body: JSON.stringify({
        status: 'account URL search relationship marker',
        visibility: 'public',
      }),
    });
    expect(statusResponse.status).toBe(200);
    mutedStatus = await statusResponse.json<{ id: string; uri: string }>();

    for (const target of [silenced, suspended]) {
      const response = await SELF.fetch(`${BASE}/api/v1/accounts/${target.accountId}/follow`, {
        method: 'POST',
        headers: authHeaders(viewer.token),
      });
      expect(response.status).toBe(200);
    }

    const muteResponse = await SELF.fetch(`${BASE}/api/v1/accounts/${muted.accountId}/mute`, {
      method: 'POST',
      headers: authHeaders(viewer.token),
    });
    expect(muteResponse.status).toBe(200);

    const reverseBlockResponse = await SELF.fetch(
      `${BASE}/api/v1/accounts/${viewer.accountId}/block`,
      { method: 'POST', headers: authHeaders(reverseBlocked.token) },
    );
    expect(reverseBlockResponse.status).toBe(200);

    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare('UPDATE accounts SET silenced_at = ?1 WHERE id = ?2')
        .bind(new Date().toISOString(), silenced.accountId),
      env.DB_META_C000.prepare('UPDATE accounts SET suspended_at = ?1 WHERE id = ?2')
        .bind(new Date().toISOString(), suspended.accountId),
      env.DB_META_C000.prepare('UPDATE users SET disabled = 1 WHERE account_id = ?1')
        .bind(frozen.accountId),
      env.DB_META_C000.prepare("UPDATE users SET approved = 0, registration_state = 'pending_approval' WHERE account_id = ?1")
        .bind(pendingApproval.accountId),
      env.DB_META_C000.prepare('UPDATE accounts SET memorial = 1 WHERE id = ?1')
        .bind(memorial.accountId),
      env.DB_META_C000.prepare('UPDATE accounts SET moved_to_account_id = ?1 WHERE id = ?2')
        .bind(active.accountId, moved.accountId),
      env.DB_META_C000.prepare(
        `INSERT INTO accounts
         (id, username, domain, display_name, note, uri, url, created_at, updated_at)
         VALUES (?1, 'acctpermsystem', NULL, 'System', '', ?2, ?3, ?4, ?4)`,
      ).bind(
        localSystemAccountId,
        `${BASE}/users/acctpermsystem`,
        `${BASE}/@acctpermsystem`,
        new Date().toISOString(),
      ),
    ]);
  });

  it('hides suspended and pending-registration resources but preserves frozen, limited, memorial, muted, and blocked canonical profiles', async () => {
    for (const endpoint of [
      `${BASE}/api/v1/accounts/${suspended.accountId}`,
      `${BASE}/api/v1/accounts/lookup?acct=acctpermsuspended`,
      `${BASE}/api/v1/accounts/${suspended.accountId}/statuses`,
      `${BASE}/api/v1/accounts/${suspended.accountId}/followers`,
      `${BASE}/api/v1/accounts/${pendingApproval.accountId}`,
      `${BASE}/api/v1/accounts/lookup?acct=acctpermpending`,
    ]) {
      const response = await SELF.fetch(endpoint, { headers: authHeaders(viewer.token) });
      expect(response.status).toBe(404);
    }

    for (const target of [frozen, moved, muted, reverseBlocked]) {
      const response = await SELF.fetch(`${BASE}/api/v1/accounts/${target.accountId}`, {
        headers: authHeaders(viewer.token),
      });
      expect(response.status).toBe(200);
    }

    const limitedResponse = await SELF.fetch(`${BASE}/api/v1/accounts/${silenced.accountId}`);
    expect(limitedResponse.status).toBe(200);
    expect((await limitedResponse.json<AccountEntity>()).limited).toBe(true);

    const anonymousLimitedFollowers = await SELF.fetch(
      `${BASE}/api/v1/accounts/${silenced.accountId}/followers`,
    );
    expect(anonymousLimitedFollowers.status).toBe(404);
    const followerLimitedFollowers = await SELF.fetch(
      `${BASE}/api/v1/accounts/${silenced.accountId}/followers`,
      { headers: authHeaders(viewer.token) },
    );
    expect(followerLimitedFollowers.status).toBe(200);

    const memorialResponse = await SELF.fetch(`${BASE}/api/v1/accounts/${memorial.accountId}`);
    expect(memorialResponse.status).toBe(200);
    expect((await memorialResponse.json<AccountEntity>()).memorial).toBe(true);

    const systemResponse = await SELF.fetch(
      `${BASE}/api/v1/accounts/${localSystemAccountId}`,
    );
    expect(systemResponse.status).toBe(200);
    expect((await systemResponse.json<AccountEntity>()).id).toBe(localSystemAccountId);
  });

  it('binds SQL-shaped account IDs and names without rejecting the legitimate cached account', async () => {
    const sqlShapedUsername = "acctperm' OR 1=1 --";
    const sqlShapedAccountId = "account-id' OR 1=1 --";
    const now = new Date().toISOString();
    await env.DB_META_C000.prepare(
      `INSERT INTO accounts
       (id, username, domain, display_name, note, uri, url, created_at, updated_at)
       VALUES (?1, ?2, ?3, '', '', ?4, ?5, ?6, ?6)`,
    ).bind(
      sqlShapedAccountId,
      sqlShapedUsername,
      'sql-name.example',
      'https://sql-name.example/users/account',
      'https://sql-name.example/@account',
      now,
    ).run();

    const byId = await SELF.fetch(
      `${BASE}/api/v1/accounts/${encodeURIComponent(sqlShapedAccountId)}`,
    );
    expect(byId.status).toBe(200);
    expect((await byId.json<AccountEntity>()).id).toBe(sqlShapedAccountId);

    const byAcct = await SELF.fetch(
      `${BASE}/api/v1/accounts/lookup?acct=${encodeURIComponent(`${sqlShapedUsername}@sql-name.example`)}`,
    );
    expect(byAcct.status).toBe(200);
    expect((await byAcct.json<AccountEntity>()).id).toBe(sqlShapedAccountId);
  });

  it('keeps blocked-domain profiles canonical while suppressing discovery and new follows', async () => {
    const now = new Date().toISOString();
    await env.DB_META_C000.prepare(
      `INSERT INTO accounts
       (id, username, domain, display_name, note, uri, url, created_at, updated_at)
       VALUES (
         'acctperm-domain-remote', 'domainhidden', 'blocked-domain.example',
         '', '', 'https://blocked-domain.example/users/domainhidden',
         'https://blocked-domain.example/@domainhidden', ?1, ?1
       )`,
    ).bind(now).run();

    const viewerCountsBefore = await env.DB_META_C000.prepare(
      `SELECT followers_count, following_count FROM accounts WHERE id = ?1`,
    ).bind(viewer.accountId).first<{
      followers_count: number;
      following_count: number;
    }>();
    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare(
        `INSERT INTO follows
         (id, account_id, target_account_id, created_at, updated_at)
         VALUES ('acctperm-domain-follow-out', ?1, 'acctperm-domain-remote', ?2, ?2)`,
      ).bind(viewer.accountId, now),
      env.DB_META_C000.prepare(
        `INSERT INTO follows
         (id, account_id, target_account_id, created_at, updated_at)
         VALUES ('acctperm-domain-follow-in', 'acctperm-domain-remote', ?1, ?2, ?2)`,
      ).bind(viewer.accountId, now),
      env.DB_META_C000.prepare(
        `UPDATE accounts
         SET followers_count = followers_count + 1,
             following_count = following_count + 1
         WHERE id IN (?1, 'acctperm-domain-remote')`,
      ).bind(viewer.accountId),
      env.DB_META_C000.prepare(
        `INSERT INTO follow_requests
         (id, account_id, target_account_id, created_at, updated_at)
         VALUES ('acctperm-domain-request', ?1, 'acctperm-domain-remote', ?2, ?2)`,
      ).bind(viewer.accountId, now),
      env.DB_META_C000.prepare(
        `INSERT INTO lists
         (id, account_id, title, created_at, updated_at)
         VALUES ('acctperm-domain-list', ?1, 'Domain list', ?2, ?2)`,
      ).bind(viewer.accountId, now),
      env.DB_META_C000.prepare(
        `INSERT INTO list_accounts (list_id, account_id)
         VALUES ('acctperm-domain-list', 'acctperm-domain-remote')`,
      ),
      env.DB_META_C000.prepare(
        `INSERT INTO account_pins
         (id, account_id, target_account_id, created_at)
         VALUES ('acctperm-domain-pin', ?1, 'acctperm-domain-remote', ?2)`,
      ).bind(viewer.accountId, now),
    ]);

    const block = await SELF.fetch(`${BASE}/api/v1/domain_blocks`, {
      method: 'POST',
      headers: authHeaders(viewer.token),
      body: JSON.stringify({ domain: 'BLOCKED-DOMAIN.EXAMPLE' }),
    });
    expect(block.status).toBe(200);

    const remainingRelationships = await env.DB_META_C000.prepare(
      `SELECT
         (SELECT COUNT(*) FROM follows
          WHERE (account_id = ?1 AND target_account_id = 'acctperm-domain-remote')
             OR (account_id = 'acctperm-domain-remote' AND target_account_id = ?1))
           AS follows_count,
         (SELECT COUNT(*) FROM follow_requests
          WHERE account_id = ?1 AND target_account_id = 'acctperm-domain-remote')
           AS requests_count,
         (SELECT COUNT(*) FROM list_accounts
          WHERE list_id = 'acctperm-domain-list'
            AND account_id = 'acctperm-domain-remote') AS lists_count,
         (SELECT COUNT(*) FROM account_pins
          WHERE account_id = ?1 AND target_account_id = 'acctperm-domain-remote')
           AS pins_count`,
    ).bind(viewer.accountId).first<{
      follows_count: number;
      requests_count: number;
      lists_count: number;
      pins_count: number;
    }>();
    expect(remainingRelationships).toEqual({
      follows_count: 0,
      requests_count: 0,
      lists_count: 0,
      pins_count: 0,
    });
    const viewerCountsAfter = await env.DB_META_C000.prepare(
      `SELECT followers_count, following_count FROM accounts WHERE id = ?1`,
    ).bind(viewer.accountId).first<{
      followers_count: number;
      following_count: number;
    }>();
    expect(viewerCountsAfter).toEqual(viewerCountsBefore);

    const exact = await SELF.fetch(
      `${BASE}/api/v1/accounts/acctperm-domain-remote`,
      { headers: authHeaders(viewer.token) },
    );
    expect(exact.status).toBe(200);

    const search = await SELF.fetch(
      `${BASE}/api/v1/accounts/search?q=domainhidden`,
      { headers: authHeaders(viewer.token) },
    );
    expect(search.status).toBe(200);
    expect((await search.json<AccountEntity[]>()).map((account) => account.id))
      .not.toContain('acctperm-domain-remote');

    const follow = await SELF.fetch(
      `${BASE}/api/v1/accounts/acctperm-domain-remote/follow`,
      { method: 'POST', headers: authHeaders(viewer.token) },
    );
    expect(follow.status).toBe(403);
  });

  it('filters suspended, pending, moved, muted, and bilaterally blocked accounts from search while retaining frozen and limited accounts', async () => {
    for (const endpoint of [
      `${BASE}/api/v1/accounts/search?q=acctperm`,
      `${BASE}/api/v2/search?q=acctperm&type=accounts`,
    ]) {
      const response = await SELF.fetch(endpoint, { headers: authHeaders(viewer.token) });
      expect(response.status).toBe(200);
      const json = endpoint.includes('/api/v1/')
        ? { accounts: await response.json<AccountEntity[]>() }
        : await response.json<SearchEntity>();
      const ids = json.accounts.map((account) => account.id);

      expect(ids).toContain(active.accountId);
      expect(ids).toContain(frozen.accountId);
      expect(ids).toContain(memorial.accountId);
      expect(ids).toContain(silenced.accountId);
      expect(ids).not.toContain(suspended.accountId);
      expect(ids).not.toContain(pendingApproval.accountId);
      expect(ids).not.toContain(moved.accountId);
      expect(ids).not.toContain(muted.accountId);
      expect(ids).not.toContain(reverseBlocked.accountId);
    }

    const anonymousSearch = await SELF.fetch(
      `${BASE}/api/v2/search?q=acctpermsilenced&type=accounts`,
    );
    expect(anonymousSearch.status).toBe(200);
    expect((await anonymousSearch.json<SearchEntity>()).accounts.map((account) => account.id))
      .toContain(silenced.accountId);
  });

  it('applies the same state policy to following-only search and relationship lists', async () => {
    const followingSearch = await SELF.fetch(
      `${BASE}/api/v1/accounts/search?q=acctperm&following=true`,
      { headers: authHeaders(viewer.token) },
    );
    expect(followingSearch.status).toBe(200);
    const followingSearchIds = (await followingSearch.json<AccountEntity[]>())
      .map((account) => account.id);
    expect(followingSearchIds).toContain(silenced.accountId);
    expect(followingSearchIds).not.toContain(suspended.accountId);

    const followingList = await SELF.fetch(
      `${BASE}/api/v1/accounts/${viewer.accountId}/following`,
      { headers: authHeaders(viewer.token) },
    );
    expect(followingList.status).toBe(200);
    const followingListIds = (await followingList.json<AccountEntity[]>())
      .map((account) => account.id);
    expect(followingListIds).toContain(silenced.accountId);
    expect(followingListIds).not.toContain(suspended.accountId);

    const relationships = await SELF.fetch(
      `${BASE}/api/v1/accounts/relationships?id[]=${suspended.accountId}`,
      { headers: authHeaders(viewer.token) },
    );
    expect(await relationships.json<RelationshipEntity[]>()).toEqual([]);

    const relationshipsWithSuspended = await SELF.fetch(
      `${BASE}/api/v1/accounts/relationships?id[]=${suspended.accountId}&with_suspended=true`,
      { headers: authHeaders(viewer.token) },
    );
    expect((await relationshipsWithSuspended.json<RelationshipEntity[]>())[0]?.id)
      .toBe(suspended.accountId);
  });

  it('rejects new follows to unavailable, pending, moved, self, and blocked targets without side effects', async () => {
    const cases: Array<{ targetId: string; expectedStatus: number }> = [
      { targetId: suspended.accountId, expectedStatus: 404 },
      { targetId: pendingApproval.accountId, expectedStatus: 404 },
      { targetId: moved.accountId, expectedStatus: 403 },
      { targetId: reverseBlocked.accountId, expectedStatus: 403 },
      { targetId: viewer.accountId, expectedStatus: 422 },
    ];

    for (const testCase of cases) {
      const response = await SELF.fetch(`${BASE}/api/v1/accounts/${testCase.targetId}/follow`, {
        method: 'POST',
        headers: authHeaders(viewer.token),
      });
      expect(response.status).toBe(testCase.expectedStatus);
    }

    const blockedFollow = await env.DB_META_C000.prepare(
      `SELECT 1 FROM follows
       WHERE account_id = ?1 AND target_account_id = ?2
       LIMIT 1`,
    ).bind(viewer.accountId, reverseBlocked.accountId).first();
    expect(blockedFollow).toBeNull();
  });

  it('allows defensive block and mute creation for a suspended target', async () => {
    const blocker = await createTestUser('acctpermsuspendedblocker');
    const muter = await createTestUser('acctpermsuspendedmuter');
    const target = await createTestUser('acctpermsuspendeddefensive');
    await env.DB_META_C000.prepare(
      'UPDATE accounts SET suspended_at = ?1 WHERE id = ?2',
    ).bind(new Date().toISOString(), target.accountId).run();

    const block = await SELF.fetch(`${BASE}/api/v1/accounts/${target.accountId}/block`, {
      method: 'POST',
      headers: authHeaders(blocker.token),
    });
    const mute = await SELF.fetch(`${BASE}/api/v1/accounts/${target.accountId}/mute`, {
      method: 'POST',
      headers: authHeaders(muter.token),
    });
    expect(block.status).toBe(200);
    expect(mute.status).toBe(200);

    const relationships = await env.DB_META_C000.prepare(
      `SELECT
         (SELECT COUNT(*) FROM blocks
          WHERE account_id = ?1 AND target_account_id = ?3) AS blocks_count,
         (SELECT COUNT(*) FROM mutes
          WHERE account_id = ?2 AND target_account_id = ?3) AS mutes_count`,
    ).bind(blocker.accountId, muter.accountId, target.accountId).first<{
      blocks_count: number;
      mutes_count: number;
    }>();
    expect(relationships).toEqual({ blocks_count: 1, mutes_count: 1 });
  });

  it('keeps a muted public status canonical but removes it from exact-URL search discovery', async () => {
    const directResponse = await SELF.fetch(`${BASE}/api/v1/statuses/${mutedStatus.id}`, {
      headers: authHeaders(viewer.token),
    });
    expect(directResponse.status).toBe(200);

    const searchResponse = await SELF.fetch(
      `${BASE}/api/v2/search?q=${encodeURIComponent(mutedStatus.uri)}&type=statuses&resolve=true`,
      { headers: authHeaders(viewer.token) },
    );
    expect(searchResponse.status).toBe(200);
    const search = await searchResponse.json<SearchEntity>();
    expect(search.statuses.some((status) => status.id === mutedStatus.id)).toBe(false);
  });

  it('updates follower counters only when the caller-owned follower relationship exists', async () => {
    const follower = await createTestUser('acctpermremovefollower');
    const followResponse = await SELF.fetch(`${BASE}/api/v1/accounts/${viewer.accountId}/follow`, {
      method: 'POST',
      headers: authHeaders(follower.token),
    });
    expect(followResponse.status).toBe(200);

    const before = await env.DB_META_C000.prepare(
      'SELECT followers_count FROM accounts WHERE id = ?1',
    ).bind(viewer.accountId).first<{ followers_count: number }>();

    for (let index = 0; index < 2; index += 1) {
      const response = await SELF.fetch(
        `${BASE}/api/v1/accounts/${follower.accountId}/remove_from_followers`,
        { method: 'POST', headers: authHeaders(viewer.token) },
      );
      expect(response.status).toBe(200);
      expect((await response.json<RelationshipEntity>()).followed_by).toBe(false);
    }

    const after = await env.DB_META_C000.prepare(
      'SELECT followers_count FROM accounts WHERE id = ?1',
    ).bind(viewer.accountId).first<{ followers_count: number }>();
    expect(after?.followers_count).toBe((before?.followers_count ?? 0) - 1);
  });

  it('returns only accounts the viewer follows as familiar followers', async () => {
    const target = await createTestUser('acctpermfamiliartarget');
    const familiar = await createTestUser('acctpermfamiliar');
    const unrelated = await createTestUser('acctpermunrelated');

    const followPairs: Array<[TestUser, TestUser]> = [
      [viewer, familiar],
      [familiar, target],
      [unrelated, viewer],
      [unrelated, target],
    ];
    for (const [actor, followTarget] of followPairs) {
      const response = await SELF.fetch(
        `${BASE}/api/v1/accounts/${followTarget.accountId}/follow`,
        { method: 'POST', headers: authHeaders(actor.token) },
      );
      expect(response.status).toBe(200);
    }

    const response = await SELF.fetch(
      `${BASE}/api/v1/accounts/familiar_followers?id[]=${target.accountId}`,
      { headers: authHeaders(viewer.token) },
    );
    expect(response.status).toBe(200);
    const result = await response.json<Array<{ id: string; accounts: AccountEntity[] }>>();
    const ids = result[0]?.accounts.map((account) => account.id) ?? [];
    expect(ids).toContain(familiar.accountId);
    expect(ids).not.toContain(unrelated.accountId);
  });

  it('requires the documented OAuth scopes for account-owned mutations', async () => {
    const scoped = await createTestUser('acctpermscopeowner');
    const scopedTarget = await createTestUser('acctpermscopetarget');
    await env.DB_META_C000.prepare(
      "UPDATE oauth_access_tokens SET scopes = 'read:accounts' WHERE user_id = ?1",
    ).bind(scoped.userId).run();

    for (const path of [
      `${scopedTarget.accountId}/note`,
      `${scopedTarget.accountId}/pin`,
      `${scopedTarget.accountId}/remove_from_followers`,
      'aliases',
      'migration',
      'change_password',
    ]) {
      const response = await SELF.fetch(`${BASE}/api/v1/accounts/${path}`, {
        method: 'POST',
        headers: authHeaders(scoped.token),
        body: JSON.stringify({ comment: 'must not be written' }),
      });
      expect(response.status).toBe(403);
    }

    const note = await env.DB_META_C000.prepare(
      `SELECT 1 FROM account_notes
       WHERE account_id = ?1 AND target_account_id = ?2`,
    ).bind(scoped.accountId, scopedTarget.accountId).first();
    expect(note).toBeNull();
  });
});
