import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Conversations API', () => {
  let alice: { accountId: string; userId: string; token: string };
  let bob: { accountId: string; userId: string; token: string };
  let convId: string;

  beforeAll(async () => {
    await applyMigration();
    alice = await createTestUser('convalice');
    bob = await createTestUser('convbob');

    // Manually create a conversation with participants
    convId = crypto.randomUUID();
    const now = new Date().toISOString();

    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO conversations (id, created_at, updated_at) VALUES (?1, ?2, ?2)',
      ).bind(convId, now),
      env.DB.prepare(
        'INSERT INTO conversation_accounts (conversation_id, account_id, last_status_id, unread) VALUES (?1, ?2, NULL, 1)',
      ).bind(convId, alice.accountId),
      env.DB.prepare(
        'INSERT INTO conversation_accounts (conversation_id, account_id, last_status_id, unread) VALUES (?1, ?2, NULL, 0)',
      ).bind(convId, bob.accountId),
    ]);
  });

  describe('GET /api/v1/conversations', () => {
    it('returns conversations for the authenticated user', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/conversations`, {
        headers: authHeaders(alice.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(1);
      expect(body[0].id).toBe(convId);
      expect(body[0].unread).toBe(true);
    });

    it('returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/conversations`);
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/conversations/:id/read', () => {
    it('marks conversation as read', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v1/conversations/${convId}/read`,
        {
          method: 'POST',
          headers: authHeaders(alice.token),
        },
      );
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.id).toBe(convId);
      expect(body.unread).toBe(false);
    });

    it('returns 404 for non-existent conversation', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v1/conversations/00000000-0000-0000-0000-000000000000/read`,
        {
          method: 'POST',
          headers: authHeaders(alice.token),
        },
      );
      expect(res.status).toBe(404);
    });

    it('returns 401 without auth', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v1/conversations/${convId}/read`,
        { method: 'POST' },
      );
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/v1/conversations/:id', () => {
    it('removes the conversation for the user', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v1/conversations/${convId}`,
        {
          method: 'DELETE',
          headers: authHeaders(alice.token),
        },
      );
      expect(res.status).toBe(200);

      // Verify it's gone from the list
      const listRes = await SELF.fetch(`${BASE}/api/v1/conversations`, {
        headers: authHeaders(alice.token),
      });
      const body = await listRes.json<any[]>();
      expect(body.length).toBe(0);
    });

    it('returns 404 for already deleted conversation', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v1/conversations/${convId}`,
        {
          method: 'DELETE',
          headers: authHeaders(alice.token),
        },
      );
      expect(res.status).toBe(404);
    });

    it('returns 401 without auth', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v1/conversations/${convId}`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(401);
    });
  });
});
