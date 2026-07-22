import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
type AccountEntity = { id: string };
type ListEntity = { id: string };

async function setTokenScopes(user: TestUser, scopes: string): Promise<void> {
  await env.DB_META_C000.prepare(
    'UPDATE oauth_access_tokens SET scopes = ?1 WHERE user_id = ?2',
  ).bind(scopes, user.userId).run();
}

async function follow(actor: TestUser, target: TestUser): Promise<Response> {
  return SELF.fetch(`${BASE}/api/v1/accounts/${target.accountId}/follow`, {
    method: 'POST',
    headers: authHeaders(actor.token),
  });
}

describe('API scope and owned-resource permissions', () => {
  beforeAll(async () => {
    await applyMigration();
  });

  it('enforces profile isolation and granular admin scope hierarchy', async () => {
    const profileOnly = await createTestUser('scopeprofile');
    const accountReader = await createTestUser('scopeaccountread');
    const adminReader = await createTestUser('scopeadminread', { role: 'admin' });
    const invalidAdmin = await createTestUser('scopeinvalidadmin', { role: 'admin' });
    await Promise.all([
      setTokenScopes(profileOnly, 'profile'),
      setTokenScopes(accountReader, 'read:accounts'),
      setTokenScopes(adminReader, 'admin:read:accounts'),
      setTokenScopes(invalidAdmin, 'admin'),
    ]);

    expect((await SELF.fetch(`${BASE}/api/v1/accounts/verify_credentials`, {
      headers: authHeaders(profileOnly.token),
    })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/api/v1/preferences`, {
      headers: authHeaders(profileOnly.token),
    })).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/api/v1/streaming?stream=user`, {
      headers: {
        ...authHeaders(profileOnly.token),
        Upgrade: 'websocket',
      },
    })).status).toBe(403);

    expect((await SELF.fetch(`${BASE}/api/v1/preferences`, {
      headers: authHeaders(accountReader.token),
    })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/api/v1/preferences`, {
      method: 'PATCH',
      headers: authHeaders(accountReader.token),
      body: JSON.stringify({ 'posting:default:sensitive': true }),
    })).status).toBe(403);

    expect((await SELF.fetch(`${BASE}/api/v1/admin/accounts`, {
      headers: authHeaders(adminReader.token),
    })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/api/v1/admin/accounts/${profileOnly.accountId}/approve`, {
      method: 'POST',
      headers: authHeaders(adminReader.token),
    })).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/api/v1/admin/accounts`, {
      headers: authHeaders(invalidAdmin.token),
    })).status).toBe(403);
  });

  it('hides and refuses stale unsafe follow requests while preserving valid approval', async () => {
    const target = await createTestUser('followreqtarget');
    const suspended = await createTestUser('followreqsuspended');
    const blocked = await createTestUser('followreqblocked');
    const active = await createTestUser('followreqactive');
    await env.DB_META_C000.prepare(
      'UPDATE accounts SET locked = 1, manually_approves_followers = 1 WHERE id = ?1',
    ).bind(target.accountId).run();

    for (const requester of [suspended, blocked, active]) {
      expect((await follow(requester, target)).status).toBe(200);
    }
    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare('UPDATE accounts SET suspended_at = ?1 WHERE id = ?2')
        .bind(new Date().toISOString(), suspended.accountId),
      env.DB_META_C000.prepare(
        'INSERT INTO blocks (id, account_id, target_account_id, created_at) VALUES (?1, ?2, ?3, ?4)',
      ).bind(crypto.randomUUID(), target.accountId, blocked.accountId, new Date().toISOString()),
    ]);

    const listResponse = await SELF.fetch(`${BASE}/api/v1/follow_requests`, {
      headers: authHeaders(target.token),
    });
    expect(listResponse.status).toBe(200);
    const requesters = await listResponse.json<AccountEntity[]>();
    expect(requesters.map((account) => account.id)).toEqual([active.accountId]);

    for (const requester of [suspended, blocked]) {
      const response = await SELF.fetch(
        `${BASE}/api/v1/follow_requests/${requester.accountId}/authorize`,
        { method: 'POST', headers: authHeaders(target.token) },
      );
      expect(response.status).toBe(403);
      const relation = await env.DB_META_C000.prepare(
        'SELECT id FROM follows WHERE account_id = ?1 AND target_account_id = ?2',
      ).bind(requester.accountId, target.accountId).first();
      expect(relation).toBeNull();
    }

    const approve = await SELF.fetch(
      `${BASE}/api/v1/follow_requests/${active.accountId}/authorize`,
      { method: 'POST', headers: authHeaders(target.token) },
    );
    expect(approve.status).toBe(200);
    expect(await env.DB_META_C000.prepare(
      'SELECT id FROM follows WHERE account_id = ?1 AND target_account_id = ?2',
    ).bind(active.accountId, target.accountId).first()).not.toBeNull();

    const rejectUnsafe = await SELF.fetch(
      `${BASE}/api/v1/follow_requests/${suspended.accountId}/reject`,
      { method: 'POST', headers: authHeaders(target.token) },
    );
    expect(rejectUnsafe.status).toBe(200);
  });

  it('allows only the list owner to add active followed accounts', async () => {
    const owner = await createTestUser('listpermowner');
    const candidate = await createTestUser('listpermcandidate');
    const stranger = await createTestUser('listpermstranger');
    const createResponse = await SELF.fetch(`${BASE}/api/v1/lists`, {
      method: 'POST',
      headers: authHeaders(owner.token),
      body: JSON.stringify({ title: 'permission list' }),
    });
    expect(createResponse.status).toBe(200);
    const list = await createResponse.json<ListEntity>();

    const add = (actor: TestUser) => SELF.fetch(`${BASE}/api/v1/lists/${list.id}/accounts`, {
      method: 'POST',
      headers: authHeaders(actor.token),
      body: JSON.stringify({ account_ids: [candidate.accountId] }),
    });
    expect((await add(owner)).status).toBe(422);
    expect((await add(stranger)).status).toBe(404);

    expect((await follow(owner, candidate)).status).toBe(200);
    expect((await add(owner)).status).toBe(200);
    const stored = await env.DB_META_C000.prepare(
      'SELECT follow_id FROM list_accounts WHERE list_id = ?1 AND account_id = ?2',
    ).bind(list.id, candidate.accountId).first<{ follow_id: string | null }>();
    expect(stored?.follow_id).not.toBeNull();

    await env.DB_META_C000.prepare('UPDATE accounts SET suspended_at = ?1 WHERE id = ?2')
      .bind(new Date().toISOString(), candidate.accountId).run();
    const membersResponse = await SELF.fetch(`${BASE}/api/v1/lists/${list.id}/accounts`, {
      headers: authHeaders(owner.token),
    });
    expect(membersResponse.status).toBe(200);
    expect(await membersResponse.json<AccountEntity[]>()).toEqual([]);
  });

  it('removes both follow directions, list membership, requests, and counters on block', async () => {
    const blocker = await createTestUser('blockpermactor');
    const blocked = await createTestUser('blockpermtarget');
    expect((await follow(blocker, blocked)).status).toBe(200);
    expect((await follow(blocked, blocker)).status).toBe(200);

    const listResponse = await SELF.fetch(`${BASE}/api/v1/lists`, {
      method: 'POST',
      headers: authHeaders(blocker.token),
      body: JSON.stringify({ title: 'block cleanup' }),
    });
    const list = await listResponse.json<ListEntity>();
    expect((await SELF.fetch(`${BASE}/api/v1/lists/${list.id}/accounts`, {
      method: 'POST',
      headers: authHeaders(blocker.token),
      body: JSON.stringify({ account_ids: [blocked.accountId] }),
    })).status).toBe(200);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await SELF.fetch(`${BASE}/api/v1/accounts/${blocked.accountId}/block`, {
        method: 'POST',
        headers: authHeaders(blocker.token),
      })).status).toBe(200);
    }

    const relationships = await env.DB_META_C000.prepare(
      `SELECT id FROM follows
       WHERE (account_id = ?1 AND target_account_id = ?2)
          OR (account_id = ?2 AND target_account_id = ?1)`,
    ).bind(blocker.accountId, blocked.accountId).all();
    expect(relationships.results).toHaveLength(0);
    const counts = await env.DB_META_C000.prepare(
      'SELECT id, followers_count, following_count FROM accounts WHERE id IN (?1, ?2)',
    ).bind(blocker.accountId, blocked.accountId).all<{
      id: string;
      followers_count: number;
      following_count: number;
    }>();
    expect(counts.results).toHaveLength(2);
    for (const account of counts.results) {
      expect(account.followers_count).toBe(0);
      expect(account.following_count).toBe(0);
    }
    expect(await env.DB_META_C000.prepare(
      'SELECT 1 FROM list_accounts WHERE list_id = ?1 AND account_id = ?2',
    ).bind(list.id, blocked.accountId).first()).toBeNull();
    expect(await env.DB_META_C000.prepare(
      `SELECT 1 FROM follow_requests
       WHERE (account_id = ?1 AND target_account_id = ?2)
          OR (account_id = ?2 AND target_account_id = ?1)`,
    ).bind(blocker.accountId, blocked.accountId).first()).toBeNull();
  });
});
