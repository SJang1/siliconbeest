import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Filters API (v2)', () => {
  let user: { accountId: string; userId: string; token: string };
  let filterId: string;

  beforeAll(async () => {
    await applyMigration();
    user = await createTestUser('filteruser');
  });

  // -------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------
  describe('POST /api/v2/filters', () => {
    it('creates a filter', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/filters`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          title: 'Test Filter',
          context: ['home', 'public'],
          filter_action: 'warn',
          keywords_attributes: [
            { keyword: 'badword', whole_word: true },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.id).toBeDefined();
      expect(body.title).toBe('Test Filter');
      expect(body.context).toContain('home');
      expect(body.context).toContain('public');
      expect(body.filter_action).toBe('warn');
      expect(body.keywords).toBeDefined();
      expect(body.keywords.length).toBe(1);
      expect(body.keywords[0].keyword).toBe('badword');
      expect(body.keywords[0].whole_word).toBe(true);
      filterId = body.id;
    });

    it('returns 422 without title', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/filters`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          context: ['home'],
        }),
      });
      expect(res.status).toBe(422);
    });

    it('returns 422 without context', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/filters`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          title: 'No context filter',
        }),
      });
      expect(res.status).toBe(422);
    });

    it('returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/filters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Unauthed filter',
          context: ['home'],
        }),
      });
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------
  describe('GET /api/v2/filters', () => {
    it('lists all filters for the user', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/filters`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      const found = body.some((f: any) => f.id === filterId);
      expect(found).toBe(true);
    });

    it('returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/filters`);
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------
  // Get single
  // -------------------------------------------------------------------
  describe('GET /api/v2/filters/:id', () => {
    it('fetches a single filter', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/filters/${filterId}`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.id).toBe(filterId);
      expect(body.title).toBe('Test Filter');
    });

    it('returns 404 for non-existent filter', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v2/filters/00000000000000000000000000`,
        { headers: authHeaders(user.token) },
      );
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------
  describe('PUT /api/v2/filters/:id', () => {
    it('updates the filter title', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/filters/${filterId}`, {
        method: 'PUT',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          title: 'Updated Filter',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.title).toBe('Updated Filter');
    });

    it('updates the filter action', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/filters/${filterId}`, {
        method: 'PUT',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          filter_action: 'hide',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.filter_action).toBe('hide');
    });

    it('returns 404 for non-existent filter', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v2/filters/00000000000000000000000000`,
        {
          method: 'PUT',
          headers: authHeaders(user.token),
          body: JSON.stringify({ title: 'Nope' }),
        },
      );
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // Keywords
  // -------------------------------------------------------------------
  describe('POST /api/v2/filters/:id/keywords', () => {
    it('adds a keyword to the filter', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v2/filters/${filterId}/keywords`,
        {
          method: 'POST',
          headers: authHeaders(user.token),
          body: JSON.stringify({
            keyword: 'anotherbad',
            whole_word: false,
          }),
        },
      );
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.id).toBeDefined();
      expect(body.keyword).toBe('anotherbad');
      expect(body.whole_word).toBe(false);
    });

    it('returns 422 without keyword', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v2/filters/${filterId}/keywords`,
        {
          method: 'POST',
          headers: authHeaders(user.token),
          body: JSON.stringify({}),
        },
      );
      expect(res.status).toBe(422);
    });

    it('returns 404 for non-existent filter', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v2/filters/00000000000000000000000000/keywords`,
        {
          method: 'POST',
          headers: authHeaders(user.token),
          body: JSON.stringify({ keyword: 'test' }),
        },
      );
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------
  describe('DELETE /api/v2/filters/:id', () => {
    it('deletes the filter', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/filters/${filterId}`, {
        method: 'DELETE',
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);

      // Verify it's gone
      const getRes = await SELF.fetch(`${BASE}/api/v2/filters/${filterId}`, {
        headers: authHeaders(user.token),
      });
      expect(getRes.status).toBe(404);
    });

    it('returns 404 for already deleted filter', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/filters/${filterId}`, {
        method: 'DELETE',
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(404);
    });
  });
});
