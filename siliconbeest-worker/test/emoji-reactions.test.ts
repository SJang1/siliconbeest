import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

/**
 * Helper to create a status directly in the DB.
 */
async function insertStatus(accountId: string, text: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const uri = `https://test.siliconbeest.local/users/test/statuses/${id}`;
  await env.DB.prepare(
    `INSERT INTO statuses (id, uri, url, account_id, text, content, visibility, local, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'public', 1, ?7, ?7)`,
  )
    .bind(id, uri, null, accountId, text, `<p>${text}</p>`, now)
    .run();
  return id;
}

describe('Emoji Reactions API', () => {
  let alice: { accountId: string; userId: string; token: string };
  let bob: { accountId: string; userId: string; token: string };

  beforeAll(async () => {
    await applyMigration();
    alice = await createTestUser('emojiAlice');
    bob = await createTestUser('emojiBob');
  });

  // =====================================================================
  // 1. React to status
  // =====================================================================
  describe('PUT /api/v1/statuses/:id/react/:emoji', () => {
    it('adds an emoji reaction to a status', async () => {
      const statusId = await insertStatus(alice.accountId, 'React to me');

      const res = await SELF.fetch(
        `${BASE}/api/v1/statuses/${statusId}/react/${encodeURIComponent('👍')}`,
        {
          method: 'PUT',
          headers: authHeaders(bob.token),
        },
      );
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      // Returns the status object
      expect(body.id).toBe(statusId);
    });
  });

  // =====================================================================
  // 2. List reactions
  // =====================================================================
  describe('GET /api/v1/statuses/:id/reactions', () => {
    it('lists reactions for a status including the emoji with count', async () => {
      const statusId = await insertStatus(alice.accountId, 'List reactions');

      // Add a reaction
      await SELF.fetch(
        `${BASE}/api/v1/statuses/${statusId}/react/${encodeURIComponent('👍')}`,
        {
          method: 'PUT',
          headers: authHeaders(bob.token),
        },
      );

      const res = await SELF.fetch(`${BASE}/api/v1/statuses/${statusId}/reactions`, {
        headers: authHeaders(alice.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);

      const thumbsUp = body.find((r: any) => r.name === '👍');
      expect(thumbsUp).toBeDefined();
      expect(thumbsUp.count).toBe(1);
      expect(thumbsUp.me).toBe(false); // alice is viewing, bob reacted
      expect(Array.isArray(thumbsUp.accounts)).toBe(true);
      expect(thumbsUp.accounts.length).toBe(1);
      expect(thumbsUp.accounts[0].id).toBe(bob.accountId);
    });

    it('marks me=true when the current user has reacted', async () => {
      const statusId = await insertStatus(alice.accountId, 'Me check');

      await SELF.fetch(
        `${BASE}/api/v1/statuses/${statusId}/react/${encodeURIComponent('❤️')}`,
        {
          method: 'PUT',
          headers: authHeaders(alice.token),
        },
      );

      const res = await SELF.fetch(`${BASE}/api/v1/statuses/${statusId}/reactions`, {
        headers: authHeaders(alice.token),
      });
      const body = await res.json<any[]>();
      const heart = body.find((r: any) => r.name === '❤️');
      expect(heart).toBeDefined();
      expect(heart.me).toBe(true);
    });
  });

  // =====================================================================
  // 3. Remove reaction
  // =====================================================================
  describe('DELETE /api/v1/statuses/:id/react/:emoji', () => {
    it('removes an emoji reaction from a status', async () => {
      const statusId = await insertStatus(alice.accountId, 'Remove reaction');

      // Add a reaction
      await SELF.fetch(
        `${BASE}/api/v1/statuses/${statusId}/react/${encodeURIComponent('👍')}`,
        {
          method: 'PUT',
          headers: authHeaders(bob.token),
        },
      );

      // Remove it
      const res = await SELF.fetch(
        `${BASE}/api/v1/statuses/${statusId}/react/${encodeURIComponent('👍')}`,
        {
          method: 'DELETE',
          headers: authHeaders(bob.token),
        },
      );
      expect(res.status).toBe(200);
    });
  });

  // =====================================================================
  // 4. After removal, reactions list is empty
  // =====================================================================
  describe('After removal reactions are cleared', () => {
    it('reactions list is empty after removing the only reaction', async () => {
      const statusId = await insertStatus(alice.accountId, 'Empty after removal');

      // Add then remove
      await SELF.fetch(
        `${BASE}/api/v1/statuses/${statusId}/react/${encodeURIComponent('🔥')}`,
        {
          method: 'PUT',
          headers: authHeaders(bob.token),
        },
      );
      await SELF.fetch(
        `${BASE}/api/v1/statuses/${statusId}/react/${encodeURIComponent('🔥')}`,
        {
          method: 'DELETE',
          headers: authHeaders(bob.token),
        },
      );

      const res = await SELF.fetch(`${BASE}/api/v1/statuses/${statusId}/reactions`, {
        headers: authHeaders(alice.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(body.length).toBe(0);
    });
  });

  // =====================================================================
  // 5. Multiple emojis on one status
  // =====================================================================
  describe('Multiple different emojis', () => {
    it('both emojis show up when the same user reacts with two different emojis', async () => {
      const statusId = await insertStatus(alice.accountId, 'Multi emoji');

      await SELF.fetch(
        `${BASE}/api/v1/statuses/${statusId}/react/${encodeURIComponent('👍')}`,
        {
          method: 'PUT',
          headers: authHeaders(bob.token),
        },
      );
      await SELF.fetch(
        `${BASE}/api/v1/statuses/${statusId}/react/${encodeURIComponent('❤️')}`,
        {
          method: 'PUT',
          headers: authHeaders(bob.token),
        },
      );

      const res = await SELF.fetch(`${BASE}/api/v1/statuses/${statusId}/reactions`, {
        headers: authHeaders(bob.token),
      });
      const body = await res.json<any[]>();
      expect(body.length).toBe(2);

      const names = body.map((r: any) => r.name);
      expect(names).toContain('👍');
      expect(names).toContain('❤️');
    });
  });

  // =====================================================================
  // 6. Multiple users react with same emoji
  // =====================================================================
  describe('Multiple users same emoji', () => {
    it('count reflects the number of distinct users', async () => {
      const statusId = await insertStatus(alice.accountId, 'Multi user react');

      await SELF.fetch(
        `${BASE}/api/v1/statuses/${statusId}/react/${encodeURIComponent('👍')}`,
        {
          method: 'PUT',
          headers: authHeaders(alice.token),
        },
      );
      await SELF.fetch(
        `${BASE}/api/v1/statuses/${statusId}/react/${encodeURIComponent('👍')}`,
        {
          method: 'PUT',
          headers: authHeaders(bob.token),
        },
      );

      const res = await SELF.fetch(`${BASE}/api/v1/statuses/${statusId}/reactions`, {
        headers: authHeaders(alice.token),
      });
      const body = await res.json<any[]>();
      const thumbsUp = body.find((r: any) => r.name === '👍');
      expect(thumbsUp).toBeDefined();
      expect(thumbsUp.count).toBe(2);
      expect(thumbsUp.me).toBe(true); // alice is viewing and reacted
      expect(thumbsUp.accounts.length).toBe(2);
    });
  });

  // =====================================================================
  // 7. Duplicate reaction is idempotent
  // =====================================================================
  describe('Duplicate reaction idempotency', () => {
    it('same user reacting with the same emoji twice does not create duplicates', async () => {
      const statusId = await insertStatus(alice.accountId, 'Idempotent react');

      // React twice with the same emoji
      await SELF.fetch(
        `${BASE}/api/v1/statuses/${statusId}/react/${encodeURIComponent('🎉')}`,
        {
          method: 'PUT',
          headers: authHeaders(bob.token),
        },
      );
      const res2 = await SELF.fetch(
        `${BASE}/api/v1/statuses/${statusId}/react/${encodeURIComponent('🎉')}`,
        {
          method: 'PUT',
          headers: authHeaders(bob.token),
        },
      );
      expect(res2.status).toBe(200);

      // Verify count is still 1
      const res = await SELF.fetch(`${BASE}/api/v1/statuses/${statusId}/reactions`, {
        headers: authHeaders(bob.token),
      });
      const body = await res.json<any[]>();
      const party = body.find((r: any) => r.name === '🎉');
      expect(party).toBeDefined();
      expect(party.count).toBe(1);
    });
  });

  // =====================================================================
  // 8. 401 without auth
  // =====================================================================
  describe('Authentication required', () => {
    it('PUT /api/v1/statuses/:id/react/:emoji returns 401 without auth', async () => {
      const statusId = await insertStatus(alice.accountId, 'Auth test');
      const res = await SELF.fetch(
        `${BASE}/api/v1/statuses/${statusId}/react/${encodeURIComponent('👍')}`,
        { method: 'PUT' },
      );
      expect(res.status).toBe(401);
    });

    it('DELETE /api/v1/statuses/:id/react/:emoji returns 401 without auth', async () => {
      const statusId = await insertStatus(alice.accountId, 'Auth test 2');
      const res = await SELF.fetch(
        `${BASE}/api/v1/statuses/${statusId}/react/${encodeURIComponent('👍')}`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(401);
    });

    it('GET /api/v1/statuses/:id/reactions works without auth (authOptional)', async () => {
      const statusId = await insertStatus(alice.accountId, 'Public reactions');
      const res = await SELF.fetch(`${BASE}/api/v1/statuses/${statusId}/reactions`);
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
    });
  });

  // =====================================================================
  // 9. 404 for nonexistent status
  // =====================================================================
  describe('Nonexistent status', () => {
    it('PUT react to nonexistent status returns 404', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v1/statuses/nonexistent-status-id/react/${encodeURIComponent('👍')}`,
        {
          method: 'PUT',
          headers: authHeaders(bob.token),
        },
      );
      expect(res.status).toBe(404);
    });

    it('DELETE react on nonexistent status returns 404', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v1/statuses/nonexistent-status-id/react/${encodeURIComponent('👍')}`,
        {
          method: 'DELETE',
          headers: authHeaders(bob.token),
        },
      );
      expect(res.status).toBe(404);
    });

    it('GET reactions on nonexistent status returns 404', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v1/statuses/nonexistent-status-id/reactions`,
        {
          headers: authHeaders(bob.token),
        },
      );
      expect(res.status).toBe(404);
    });
  });

  // =====================================================================
  // Reaction response structure
  // =====================================================================
  describe('Reaction response structure', () => {
    it('each reaction entry has name, count, me, url, static_url, accounts', async () => {
      const statusId = await insertStatus(alice.accountId, 'Structure check');
      await SELF.fetch(
        `${BASE}/api/v1/statuses/${statusId}/react/${encodeURIComponent('✅')}`,
        {
          method: 'PUT',
          headers: authHeaders(bob.token),
        },
      );

      const res = await SELF.fetch(`${BASE}/api/v1/statuses/${statusId}/reactions`, {
        headers: authHeaders(bob.token),
      });
      const body = await res.json<any[]>();
      expect(body.length).toBeGreaterThanOrEqual(1);

      const entry = body[0];
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.count).toBe('number');
      expect(typeof entry.me).toBe('boolean');
      // url and static_url are null for unicode emojis, non-null for custom
      expect('url' in entry).toBe(true);
      expect('static_url' in entry).toBe(true);
      expect(Array.isArray(entry.accounts)).toBe(true);

      // Each account in the list
      const account = entry.accounts[0];
      expect(typeof account.id).toBe('string');
      expect(typeof account.username).toBe('string');
      expect(typeof account.acct).toBe('string');
    });
  });
});
