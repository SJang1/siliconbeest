import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Timelines API', () => {
  let poster: { accountId: string; userId: string; token: string };
  let reader: { accountId: string; userId: string; token: string };
  const statusIds: string[] = [];

  beforeAll(async () => {
    await applyMigration();
    poster = await createTestUser('tlposter');
    reader = await createTestUser('tlreader');

    // Reader follows poster so posts appear on home timeline
    await SELF.fetch(`${BASE}/api/v1/accounts/${poster.accountId}/follow`, {
      method: 'POST',
      headers: authHeaders(reader.token),
    });

    // Create several public posts for timeline and pagination tests
    for (let i = 0; i < 5; i++) {
      const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
        method: 'POST',
        headers: authHeaders(poster.token),
        body: JSON.stringify({
          status: `Timeline post number ${i} #testhashtag`,
          visibility: 'public',
        }),
      });
      const body = await res.json<Record<string, any>>();
      statusIds.push(body.id);
    }
  });

  // -------------------------------------------------------------------
  // Public timeline
  // -------------------------------------------------------------------
  describe('GET /api/v1/timelines/public', () => {
    it('returns public statuses', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/timelines/public`, {
        headers: authHeaders(reader.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
    });

    it('filters local posts with ?local=true', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/timelines/public?local=true`, {
        headers: authHeaders(reader.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
      // All statuses created in tests are local
      expect(body.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------
  // Home timeline
  // -------------------------------------------------------------------
  describe('GET /api/v1/timelines/home', () => {
    it('returns the home timeline for the authenticated user', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/timelines/home`, {
        headers: authHeaders(reader.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
    });

    it('returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/timelines/home`);
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------
  // Hashtag timeline
  // -------------------------------------------------------------------
  describe('GET /api/v1/timelines/tag/:tag', () => {
    it('returns statuses with the specified hashtag', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/timelines/tag/testhashtag`, {
        headers: authHeaders(reader.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------
  describe('Pagination', () => {
    it('supports max_id for pagination', async () => {
      // Get the full public timeline
      const firstPage = await SELF.fetch(`${BASE}/api/v1/timelines/public?limit=2`, {
        headers: authHeaders(reader.token),
      });
      expect(firstPage.status).toBe(200);
      const firstBody = await firstPage.json<any[]>();
      expect(firstBody.length).toBeGreaterThanOrEqual(1);

      if (firstBody.length >= 2) {
        const lastId = firstBody[firstBody.length - 1].id;
        const secondPage = await SELF.fetch(`${BASE}/api/v1/timelines/public?max_id=${lastId}&limit=2`, {
          headers: authHeaders(reader.token),
        });
        expect(secondPage.status).toBe(200);
        const secondBody = await secondPage.json<any[]>();
        expect(Array.isArray(secondBody)).toBe(true);
        // The second page should not contain IDs from the first page
        const firstIds = new Set(firstBody.map((s: any) => s.id));
        for (const s of secondBody) {
          expect(firstIds.has(s.id)).toBe(false);
        }
      }
    });

    it('supports since_id for pagination', async () => {
      if (statusIds.length >= 2) {
        const sinceId = statusIds[0]; // earliest
        const res = await SELF.fetch(`${BASE}/api/v1/timelines/public?since_id=${sinceId}&limit=5`, {
          headers: authHeaders(reader.token),
        });
        expect(res.status).toBe(200);
        const body = await res.json<any[]>();
        expect(Array.isArray(body)).toBe(true);
      }
    });
  });
});
