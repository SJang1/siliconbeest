import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Bookmarks and Favourites API', () => {
  let bkUser: { accountId: string; userId: string; token: string };
  let bkAuthor: { accountId: string; userId: string; token: string };
  let favUser: { accountId: string; userId: string; token: string };
  let favAuthor: { accountId: string; userId: string; token: string };
  let bkStatusId1: string;
  let bkStatusId2: string;
  let favStatusId1: string;
  let favStatusId2: string;

  beforeAll(async () => {
    await applyMigration();
    bkUser = await createTestUser('bkuser');
    bkAuthor = await createTestUser('bkauthor');
    favUser = await createTestUser('favuser');
    favAuthor = await createTestUser('favauthor');

    // Create statuses for bookmarks
    const bkRes1 = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(bkAuthor.token),
      body: JSON.stringify({ status: 'Bookmarkable post 1' }),
    });
    bkStatusId1 = ((await bkRes1.json()) as any).id;

    const bkRes2 = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(bkAuthor.token),
      body: JSON.stringify({ status: 'Bookmarkable post 2' }),
    });
    bkStatusId2 = ((await bkRes2.json()) as any).id;

    // Bookmark both
    await SELF.fetch(`${BASE}/api/v1/statuses/${bkStatusId1}/bookmark`, {
      method: 'POST',
      headers: authHeaders(bkUser.token),
    });
    await SELF.fetch(`${BASE}/api/v1/statuses/${bkStatusId2}/bookmark`, {
      method: 'POST',
      headers: authHeaders(bkUser.token),
    });

    // Create statuses for favourites
    const favRes1 = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(favAuthor.token),
      body: JSON.stringify({ status: 'Favouritable post 1' }),
    });
    favStatusId1 = ((await favRes1.json()) as any).id;

    const favRes2 = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(favAuthor.token),
      body: JSON.stringify({ status: 'Favouritable post 2' }),
    });
    favStatusId2 = ((await favRes2.json()) as any).id;

    // Favourite both
    await SELF.fetch(`${BASE}/api/v1/statuses/${favStatusId1}/favourite`, {
      method: 'POST',
      headers: authHeaders(favUser.token),
    });
    await SELF.fetch(`${BASE}/api/v1/statuses/${favStatusId2}/favourite`, {
      method: 'POST',
      headers: authHeaders(favUser.token),
    });
  });

  // -------------------------------------------------------------------
  // Bookmarks
  // -------------------------------------------------------------------
  describe('GET /api/v1/bookmarks', () => {
    it('returns bookmarked statuses', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/bookmarks`, {
        headers: authHeaders(bkUser.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(2);
    });

    it('returns Status objects with expected fields', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/bookmarks`, {
        headers: authHeaders(bkUser.token),
      });
      const body = await res.json<any[]>();
      const status = body[0];
      expect(status.id).toBeDefined();
      expect(status.content).toBeDefined();
      expect(status.account).toBeDefined();
      expect(status.account.username).toBe('bkauthor');
    });

    it('returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/bookmarks`);
      expect(res.status).toBe(401);
    });

    it('returns empty array when no bookmarks', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/bookmarks`, {
        headers: authHeaders(bkAuthor.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(body.length).toBe(0);
    });

    it('supports limit pagination', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/bookmarks?limit=1`, {
        headers: authHeaders(bkUser.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(body.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------
  // Favourites
  // -------------------------------------------------------------------
  describe('GET /api/v1/favourites', () => {
    it('returns favourited statuses', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/favourites`, {
        headers: authHeaders(favUser.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(2);
    });

    it('returns Status objects with expected fields', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/favourites`, {
        headers: authHeaders(favUser.token),
      });
      const body = await res.json<any[]>();
      const status = body[0];
      expect(status.id).toBeDefined();
      expect(status.content).toBeDefined();
      expect(status.account).toBeDefined();
      expect(status.account.username).toBe('favauthor');
    });

    it('returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/favourites`);
      expect(res.status).toBe(401);
    });

    it('returns empty array when no favourites', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/favourites`, {
        headers: authHeaders(favAuthor.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(body.length).toBe(0);
    });

    it('supports limit pagination', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/favourites?limit=1`, {
        headers: authHeaders(favUser.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(body.length).toBe(1);
    });
  });
});
