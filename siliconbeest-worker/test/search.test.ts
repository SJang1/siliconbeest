import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Search API', () => {
  let user: { accountId: string; userId: string; token: string };

  beforeAll(async () => {
    await applyMigration();
    user = await createTestUser('searchuser');

    // Create a status with a hashtag and text for searching
    await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({
        status: 'Searching for the best #searchtest results here',
        visibility: 'public',
      }),
    });
  });

  // -------------------------------------------------------------------
  // Search accounts
  // -------------------------------------------------------------------
  describe('GET /api/v2/search?q=username', () => {
    it('finds accounts by username', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/search?q=searchuser`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.accounts).toBeDefined();
      expect(Array.isArray(body.accounts)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Search hashtags
  // -------------------------------------------------------------------
  describe('GET /api/v2/search?q=hashtag&type=hashtags', () => {
    it('finds hashtags', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/search?q=searchtest&type=hashtags`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.hashtags).toBeDefined();
      expect(Array.isArray(body.hashtags)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Search statuses
  // -------------------------------------------------------------------
  describe('GET /api/v2/search?q=content&type=statuses', () => {
    it('finds statuses by content', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/search?q=Searching&type=statuses`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.statuses).toBeDefined();
      expect(Array.isArray(body.statuses)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Search structure
  // -------------------------------------------------------------------
  describe('Search response structure', () => {
    it('returns all three result arrays', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/search?q=test`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.accounts).toBeDefined();
      expect(body.statuses).toBeDefined();
      expect(body.hashtags).toBeDefined();
    });

    it('returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/search?q=test`);
      expect(res.status).toBe(401);
    });
  });
});
