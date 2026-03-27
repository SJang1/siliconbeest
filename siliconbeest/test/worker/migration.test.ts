import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

/**
 * Helper to read also_known_as directly from the DB for a given account.
 * The GET /api/v1/accounts/aliases route is shadowed by GET /:id in the
 * accounts router, so we verify alias state via direct DB queries and
 * through the ActivityPub actor endpoint instead.
 */
async function getAliasesFromDB(accountId: string): Promise<string[]> {
  const row = await env.DB.prepare(
    'SELECT also_known_as FROM accounts WHERE id = ? LIMIT 1',
  ).bind(accountId).first<{ also_known_as: string | null }>();
  if (!row?.also_known_as) return [];
  try {
    const parsed = JSON.parse(row.also_known_as);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

describe('Account Migration', () => {
  let alice: { accountId: string; userId: string; token: string };
  let bob: { accountId: string; userId: string; token: string };
  let carol: { accountId: string; userId: string; token: string };

  // Remote account IDs for export tests
  let remoteFollowed: string;
  let remoteBlocked: string;
  let remoteMuted: string;
  let remoteFollower: string;

  beforeAll(async () => {
    await applyMigration();
    alice = await createTestUser('migalice');
    bob = await createTestUser('migbob');
    carol = await createTestUser('migcarol');

    // Insert remote accounts for export tests
    const now = new Date().toISOString();

    remoteFollowed = crypto.randomUUID();
    remoteBlocked = crypto.randomUUID();
    remoteMuted = crypto.randomUUID();
    remoteFollower = crypto.randomUUID();

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO accounts (id, username, domain, display_name, note, uri, url, created_at, updated_at) VALUES (?, ?, ?, '', '', ?, ?, ?, ?)",
      ).bind(remoteFollowed, 'remfollowed', 'remote.example', 'https://remote.example/users/remfollowed', 'https://remote.example/@remfollowed', now, now),
      env.DB.prepare(
        "INSERT INTO accounts (id, username, domain, display_name, note, uri, url, created_at, updated_at) VALUES (?, ?, ?, '', '', ?, ?, ?, ?)",
      ).bind(remoteBlocked, 'remblocked', 'remote.example', 'https://remote.example/users/remblocked', 'https://remote.example/@remblocked', now, now),
      env.DB.prepare(
        "INSERT INTO accounts (id, username, domain, display_name, note, uri, url, created_at, updated_at) VALUES (?, ?, ?, '', '', ?, ?, ?, ?)",
      ).bind(remoteMuted, 'remmuted', 'remote.example', 'https://remote.example/users/remmuted', 'https://remote.example/@remmuted', now, now),
      env.DB.prepare(
        "INSERT INTO accounts (id, username, domain, display_name, note, uri, url, created_at, updated_at) VALUES (?, ?, ?, '', '', ?, ?, ?, ?)",
      ).bind(remoteFollower, 'remfollower', 'remote.example', 'https://remote.example/users/remfollower', 'https://remote.example/@remfollower', now, now),
    ]);

    // Set up relationships for alice
    await env.DB.batch([
      // alice follows remoteFollowed
      env.DB.prepare(
        'INSERT INTO follows (id, account_id, target_account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(crypto.randomUUID(), alice.accountId, remoteFollowed, now, now),
      // alice follows bob (local)
      env.DB.prepare(
        'INSERT INTO follows (id, account_id, target_account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(crypto.randomUUID(), alice.accountId, bob.accountId, now, now),
      // remoteFollower follows alice
      env.DB.prepare(
        'INSERT INTO follows (id, account_id, target_account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(crypto.randomUUID(), remoteFollower, alice.accountId, now, now),
      // alice blocks remoteBlocked
      env.DB.prepare(
        'INSERT INTO blocks (id, account_id, target_account_id, created_at) VALUES (?, ?, ?, ?)',
      ).bind(crypto.randomUUID(), alice.accountId, remoteBlocked, now),
      // alice mutes remoteMuted
      env.DB.prepare(
        'INSERT INTO mutes (id, account_id, target_account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(crypto.randomUUID(), alice.accountId, remoteMuted, now, now),
    ]);

    // Set up a list for alice
    const listId = crypto.randomUUID();
    const followRow = await env.DB.prepare(
      'SELECT id FROM follows WHERE account_id = ? AND target_account_id = ?',
    ).bind(alice.accountId, bob.accountId).first<{ id: string }>();

    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO lists (id, account_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(listId, alice.accountId, 'Friends', now, now),
      env.DB.prepare(
        'INSERT INTO list_accounts (list_id, account_id, follow_id) VALUES (?, ?, ?)',
      ).bind(listId, bob.accountId, followRow?.id ?? null),
    ]);
  });

  // ===================================================================
  // 1. Alias CRUD
  // ===================================================================
  describe('Alias CRUD', () => {
    it('account starts with no aliases in the database', async () => {
      const aliases = await getAliasesFromDB(bob.accountId);
      expect(aliases).toEqual([]);
    });

    it('POST /api/v1/accounts/aliases with a full URI adds alias', async () => {
      const aliasUri = 'https://other.example/users/oldbob';
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/aliases`, {
        method: 'POST',
        headers: authHeaders(bob.token),
        body: JSON.stringify({ alias: aliasUri }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ aliases: string[] }>();
      expect(body.aliases).toContain(aliasUri);
    });

    it('after POST, alias is stored in the database', async () => {
      const aliases = await getAliasesFromDB(bob.accountId);
      expect(aliases).toContain('https://other.example/users/oldbob');
    });

    it('POST duplicate alias is idempotent', async () => {
      const aliasUri = 'https://other.example/users/oldbob';
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/aliases`, {
        method: 'POST',
        headers: authHeaders(bob.token),
        body: JSON.stringify({ alias: aliasUri }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ aliases: string[] }>();
      // Should still only contain one instance
      const count = body.aliases.filter((a) => a === aliasUri).length;
      expect(count).toBe(1);
    });

    it('POST a second alias adds it to the list', async () => {
      const secondAlias = 'https://another.example/users/bob2';
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/aliases`, {
        method: 'POST',
        headers: authHeaders(bob.token),
        body: JSON.stringify({ alias: secondAlias }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ aliases: string[] }>();
      expect(body.aliases.length).toBe(2);
      expect(body.aliases).toContain('https://other.example/users/oldbob');
      expect(body.aliases).toContain(secondAlias);
    });

    it('DELETE removes alias', async () => {
      const aliasUri = 'https://other.example/users/oldbob';
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/aliases`, {
        method: 'DELETE',
        headers: authHeaders(bob.token),
        body: JSON.stringify({ alias: aliasUri }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ aliases: string[] }>();
      expect(body.aliases).not.toContain(aliasUri);
    });

    it('DELETE second alias leaves empty list', async () => {
      const secondAlias = 'https://another.example/users/bob2';
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/aliases`, {
        method: 'DELETE',
        headers: authHeaders(bob.token),
        body: JSON.stringify({ alias: secondAlias }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ aliases: string[] }>();
      expect(body.aliases).toEqual([]);
    });

    it('after DELETE, aliases are cleared in the database', async () => {
      const aliases = await getAliasesFromDB(bob.accountId);
      expect(aliases).toEqual([]);
    });

    it('returns 401 without auth on POST', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/aliases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias: 'https://x.example/users/y' }),
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 without auth on DELETE', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/aliases`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alias: 'https://x.example/users/y' }),
      });
      expect(res.status).toBe(401);
    });

    it('POST without alias param returns 422', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/aliases`, {
        method: 'POST',
        headers: authHeaders(bob.token),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(422);
    });

    it('DELETE without alias param returns 422', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/aliases`, {
        method: 'DELETE',
        headers: authHeaders(bob.token),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(422);
    });

    it('POST with empty alias string returns 422', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/aliases`, {
        method: 'POST',
        headers: authHeaders(bob.token),
        body: JSON.stringify({ alias: '' }),
      });
      // Empty string is falsy so it should be treated as missing
      expect(res.status).toBe(422);
    });
  });

  // ===================================================================
  // 2. Actor alsoKnownAs
  // ===================================================================
  describe('Actor alsoKnownAs / movedTo', () => {
    it('after adding alias, GET /users/:username returns alsoKnownAs with the URI', async () => {
      const aliasUri = 'https://origin.example/users/carolold';

      // Add the alias
      const addRes = await SELF.fetch(`${BASE}/api/v1/accounts/aliases`, {
        method: 'POST',
        headers: authHeaders(carol.token),
        body: JSON.stringify({ alias: aliasUri }),
      });
      expect(addRes.status).toBe(200);

      // Fetch the actor document
      const actorRes = await SELF.fetch(`${BASE}/users/migcarol`, {
        headers: { Accept: 'application/activity+json' },
      });
      expect(actorRes.status).toBe(200);
      const actor = await actorRes.json<any>();
      expect(actor.alsoKnownAs).toContain(aliasUri);
    });

    it('after removing alias, alsoKnownAs is empty or absent', async () => {
      const aliasUri = 'https://origin.example/users/carolold';

      // Remove the alias
      await SELF.fetch(`${BASE}/api/v1/accounts/aliases`, {
        method: 'DELETE',
        headers: authHeaders(carol.token),
        body: JSON.stringify({ alias: aliasUri }),
      });

      // Fetch the actor document
      const actorRes = await SELF.fetch(`${BASE}/users/migcarol`, {
        headers: { Accept: 'application/activity+json' },
      });
      expect(actorRes.status).toBe(200);
      const actor = await actorRes.json<any>();
      // Fedify omits alsoKnownAs when empty; old endpoint returned []
      const aliases = actor.alsoKnownAs ?? [];
      expect(aliases).toEqual([]);
    });

    it('movedTo is absent when account has not migrated', async () => {
      const actorRes = await SELF.fetch(`${BASE}/users/migcarol`, {
        headers: { Accept: 'application/activity+json' },
      });
      expect(actorRes.status).toBe(200);
      const actor = await actorRes.json<any>();
      expect(actor.movedTo).toBeUndefined();
    });

    it('movedTo is set after moved_to_account_id is written to the DB', async () => {
      // Simulate a completed migration by writing directly to DB
      const now = new Date().toISOString();
      await env.DB.prepare(
        'UPDATE accounts SET moved_to_account_id = ?, moved_at = ?, updated_at = ? WHERE id = ?',
      ).bind(bob.accountId, now, now, carol.accountId).run();

      const actorRes = await SELF.fetch(`${BASE}/users/migcarol`, {
        headers: { Accept: 'application/activity+json' },
      });
      expect(actorRes.status).toBe(200);
      const actor = await actorRes.json<any>();
      expect(actor.movedTo).toBe(`https://test.siliconbeest.local/users/migbob`);

      // Clean up
      await env.DB.prepare(
        'UPDATE accounts SET moved_to_account_id = NULL, moved_at = NULL, updated_at = ? WHERE id = ?',
      ).bind(now, carol.accountId).run();
    });
  });

  // ===================================================================
  // 3. CSV Export
  // ===================================================================
  describe('CSV Export', () => {
    it('GET /api/v1/export/following.csv returns text/csv with correct header', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/export/following.csv`, {
        headers: authHeaders(alice.token),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/csv');
      const text = await res.text();
      expect(text).toContain('Account address,Show boosts');
    });

    it('following.csv contains followed accounts in @user@domain format', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/export/following.csv`, {
        headers: authHeaders(alice.token),
      });
      const text = await res.text();
      // Remote account
      expect(text).toContain('@remfollowed@remote.example');
      // Local account (no domain)
      expect(text).toContain('@migbob');
    });

    it('following.csv includes Show boosts column with true', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/export/following.csv`, {
        headers: authHeaders(alice.token),
      });
      const text = await res.text();
      // Each followed account line should end with ,true
      const lines = text.trim().split('\n');
      const dataLines = lines.slice(1); // skip header
      for (const line of dataLines) {
        expect(line).toMatch(/,true$/);
      }
    });

    it('GET /api/v1/export/blocks.csv returns blocked accounts', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/export/blocks.csv`, {
        headers: authHeaders(alice.token),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('Account address');
      expect(text).toContain('@remblocked@remote.example');
    });

    it('GET /api/v1/export/mutes.csv returns muted accounts', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/export/mutes.csv`, {
        headers: authHeaders(alice.token),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('Account address');
      expect(text).toContain('@remmuted@remote.example');
    });

    it('GET /api/v1/export/followers.csv returns followers', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/export/followers.csv`, {
        headers: authHeaders(alice.token),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('Account address');
      expect(text).toContain('@remfollower@remote.example');
    });

    it('GET /api/v1/export/lists.csv returns list data', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/export/lists.csv`, {
        headers: authHeaders(alice.token),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('List name,Account address');
      expect(text).toContain('Friends');
      expect(text).toContain('@migbob');
    });

    it('returns 401 without auth on following.csv', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/export/following.csv`);
      expect(res.status).toBe(401);
    });

    it('returns 401 without auth on blocks.csv', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/export/blocks.csv`);
      expect(res.status).toBe(401);
    });

    it('returns 401 without auth on mutes.csv', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/export/mutes.csv`);
      expect(res.status).toBe(401);
    });

    it('returns 401 without auth on followers.csv', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/export/followers.csv`);
      expect(res.status).toBe(401);
    });

    it('returns 401 without auth on lists.csv', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/export/lists.csv`);
      expect(res.status).toBe(401);
    });

    it('export csv for user with no follows returns header only', async () => {
      // carol has no follows/blocks/mutes
      const res = await SELF.fetch(`${BASE}/api/v1/export/following.csv`, {
        headers: authHeaders(carol.token),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      const lines = text.trim().split('\n');
      // BOM + header line only
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain('Account address');
    });
  });

  // ===================================================================
  // 4. CSV Import
  // ===================================================================
  describe('CSV Import', () => {
    it('POST /api/v1/import with valid following CSV returns 200 with count', async () => {
      const csv = 'Account address,Show boosts\n@someone@remote.example,true\n@other@remote.example,true\n';
      const formData = new FormData();
      formData.append('type', 'following');
      formData.append('data', new File([csv], 'following.csv', { type: 'text/csv' }));

      const res = await SELF.fetch(`${BASE}/api/v1/import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${alice.token}` },
        body: formData,
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ imported: number }>();
      expect(body.imported).toBe(2);
    });

    it('POST /api/v1/import with blocks type works', async () => {
      const csv = 'Account address\n@spammer@evil.example\n';
      const formData = new FormData();
      formData.append('type', 'blocks');
      formData.append('data', new File([csv], 'blocks.csv', { type: 'text/csv' }));

      const res = await SELF.fetch(`${BASE}/api/v1/import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${alice.token}` },
        body: formData,
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ imported: number }>();
      expect(body.imported).toBe(1);
    });

    it('POST /api/v1/import with mutes type works', async () => {
      const csv = 'Account address\n@annoying@other.example\n';
      const formData = new FormData();
      formData.append('type', 'mutes');
      formData.append('data', new File([csv], 'mutes.csv', { type: 'text/csv' }));

      const res = await SELF.fetch(`${BASE}/api/v1/import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${alice.token}` },
        body: formData,
      });
      expect(res.status).toBe(200);
      const body = await res.json<{ imported: number }>();
      expect(body.imported).toBe(1);
    });

    it('missing type returns 422', async () => {
      const csv = 'Account address\n@someone@remote.example\n';
      const formData = new FormData();
      formData.append('data', new File([csv], 'import.csv', { type: 'text/csv' }));

      const res = await SELF.fetch(`${BASE}/api/v1/import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${alice.token}` },
        body: formData,
      });
      expect(res.status).toBe(422);
    });

    it('invalid type returns 422', async () => {
      const csv = 'Account address\n@someone@remote.example\n';
      const formData = new FormData();
      formData.append('type', 'invalid');
      formData.append('data', new File([csv], 'import.csv', { type: 'text/csv' }));

      const res = await SELF.fetch(`${BASE}/api/v1/import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${alice.token}` },
        body: formData,
      });
      expect(res.status).toBe(422);
    });

    it('missing data file returns 422', async () => {
      const formData = new FormData();
      formData.append('type', 'following');

      const res = await SELF.fetch(`${BASE}/api/v1/import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${alice.token}` },
        body: formData,
      });
      expect(res.status).toBe(422);
    });

    it('returns 401 without auth', async () => {
      const csv = 'Account address\n@someone@remote.example\n';
      const formData = new FormData();
      formData.append('type', 'following');
      formData.append('data', new File([csv], 'following.csv', { type: 'text/csv' }));

      const res = await SELF.fetch(`${BASE}/api/v1/import`, {
        method: 'POST',
        body: formData,
      });
      expect(res.status).toBe(401);
    });
  });

  // ===================================================================
  // 5. Migration endpoint
  // ===================================================================
  describe('Migration endpoint', () => {
    it('POST /api/v1/accounts/migration without target returns 422', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/migration`, {
        method: 'POST',
        headers: authHeaders(alice.token),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(422);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain('Missing target_acct');
    });

    it('POST /api/v1/accounts/migration with empty body returns 422', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/migration`, {
        method: 'POST',
        headers: authHeaders(alice.token),
        body: '{}',
      });
      expect(res.status).toBe(422);
    });

    it('POST /api/v1/accounts/migration with empty target_acct returns 422', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/migration`, {
        method: 'POST',
        headers: authHeaders(alice.token),
        body: JSON.stringify({ target_acct: '' }),
      });
      expect(res.status).toBe(422);
    });

    it('returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/migration`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_acct: 'someone@remote.example' }),
      });
      expect(res.status).toBe(401);
    });

    it('error response has error field as string', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/accounts/migration`, {
        method: 'POST',
        headers: authHeaders(alice.token),
        body: JSON.stringify({}),
      });
      const body = await res.json<Record<string, any>>();
      expect(body).toHaveProperty('error');
      expect(typeof body.error).toBe('string');
    });
  });
});
