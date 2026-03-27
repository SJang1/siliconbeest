import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Lists API', () => {
  let owner: { accountId: string; userId: string; token: string };
  let member: { accountId: string; userId: string; token: string };
  let listId: string;

  beforeAll(async () => {
    await applyMigration();
    owner = await createTestUser('listowner');
    member = await createTestUser('listmember');
  });

  // -------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------
  describe('POST /api/v1/lists', () => {
    it('creates a new list', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/lists`, {
        method: 'POST',
        headers: authHeaders(owner.token),
        body: JSON.stringify({ title: 'My Test List' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.title).toBe('My Test List');
      expect(body.id).toBeDefined();
      listId = body.id;
    });

    it('returns 422 without title', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/lists`, {
        method: 'POST',
        headers: authHeaders(owner.token),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(422);
    });

    it('returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/lists`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'No Auth' }),
      });
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------
  // List all
  // -------------------------------------------------------------------
  describe('GET /api/v1/lists', () => {
    it('includes the created list', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/lists`, {
        headers: authHeaders(owner.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
      const found = body.some((l: any) => l.id === listId);
      expect(found).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------
  describe('PUT /api/v1/lists/:id', () => {
    it('updates the list title', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/lists/${listId}`, {
        method: 'PUT',
        headers: authHeaders(owner.token),
        body: JSON.stringify({ title: 'Updated Title' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.title).toBe('Updated Title');
    });
  });

  // -------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------
  describe('List account management', () => {
    it('POST /api/v1/lists/:id/accounts adds a member', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/lists/${listId}/accounts`, {
        method: 'POST',
        headers: authHeaders(owner.token),
        body: JSON.stringify({ account_ids: [member.accountId] }),
      });
      expect(res.status).toBe(200);
    });

    it('GET /api/v1/lists/:id/accounts includes the member', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/lists/${listId}/accounts`, {
        headers: authHeaders(owner.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
      const found = body.some((a: any) => a.id === member.accountId);
      expect(found).toBe(true);
    });

    it('DELETE /api/v1/lists/:id/accounts removes a member', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/lists/${listId}/accounts`, {
        method: 'DELETE',
        headers: authHeaders(owner.token),
        body: JSON.stringify({ account_ids: [member.accountId] }),
      });
      expect(res.status).toBe(200);

      // Verify removal
      const checkRes = await SELF.fetch(`${BASE}/api/v1/lists/${listId}/accounts`, {
        headers: authHeaders(owner.token),
      });
      const checkBody = await checkRes.json<any[]>();
      const stillPresent = checkBody.some((a: any) => a.id === member.accountId);
      expect(stillPresent).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------
  describe('DELETE /api/v1/lists/:id', () => {
    it('deletes the list', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/lists/${listId}`, {
        method: 'DELETE',
        headers: authHeaders(owner.token),
      });
      expect(res.status).toBe(200);

      // Verify deletion
      const checkRes = await SELF.fetch(`${BASE}/api/v1/lists/${listId}`, {
        headers: authHeaders(owner.token),
      });
      expect(checkRes.status).toBe(404);
    });
  });
});
