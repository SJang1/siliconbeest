import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Statuses API', () => {
  let user: { accountId: string; userId: string; token: string };
  let other: { accountId: string; userId: string; token: string };
  let statusId: string;

  beforeAll(async () => {
    await applyMigration();
    user = await createTestUser('statususer');
    other = await createTestUser('statusother');
  });

  // -------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------
  describe('POST /api/v1/statuses', () => {
    it('creates a public status', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          status: 'Hello, world!',
          visibility: 'public',
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.id).toBeDefined();
      expect(body.content).toContain('Hello, world!');
      expect(body.visibility).toBe('public');
      expect(body.account.username).toBe('statususer');
      statusId = body.id;
    });

    it('creates a status with content warning', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          status: 'Sensitive content here',
          spoiler_text: 'CW: Test',
          sensitive: true,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.spoiler_text).toBe('CW: Test');
      expect(body.sensitive).toBe(true);
    });

    it('creates an unlisted status', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          status: 'Unlisted post',
          visibility: 'unlisted',
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.visibility).toBe('unlisted');
    });

    it('returns 422 for empty status without media', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({ status: '' }),
      });

      expect(res.status).toBe(422);
    });

    it('returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'No auth' }),
      });

      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------
  // Fetch
  // -------------------------------------------------------------------
  describe('GET /api/v1/statuses/:id', () => {
    it('returns the created status', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/statuses/${statusId}`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.id).toBe(statusId);
      expect(body.content).toContain('Hello, world!');
    });

    it('returns 404 for non-existent status', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/statuses/00000000000000000000000000`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // Favourite / Unfavourite
  // -------------------------------------------------------------------
  describe('Favourite and Unfavourite', () => {
    it('POST /api/v1/statuses/:id/favourite favourites the status', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/statuses/${statusId}/favourite`, {
        method: 'POST',
        headers: authHeaders(other.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.favourited).toBe(true);
    });

    it('GET /api/v1/favourites includes the favourited status', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/favourites`, {
        headers: authHeaders(other.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
      const found = body.some((s: any) => s.id === statusId);
      expect(found).toBe(true);
    });

    it('POST /api/v1/statuses/:id/unfavourite unfavourites the status', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/statuses/${statusId}/unfavourite`, {
        method: 'POST',
        headers: authHeaders(other.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.favourited).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Reblog / Unreblog
  // -------------------------------------------------------------------
  describe('Reblog and Unreblog', () => {
    it('POST /api/v1/statuses/:id/reblog reblogs the status', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/statuses/${statusId}/reblog`, {
        method: 'POST',
        headers: authHeaders(other.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.reblog).toBeDefined();
      expect(body.reblog?.id).toBe(statusId);
    });

    it('POST /api/v1/statuses/:id/unreblog unreblogs the status', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/statuses/${statusId}/unreblog`, {
        method: 'POST',
        headers: authHeaders(other.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.id).toBe(statusId);
    });
  });

  // -------------------------------------------------------------------
  // Bookmark / Unbookmark
  // -------------------------------------------------------------------
  describe('Bookmark and Unbookmark', () => {
    it('POST /api/v1/statuses/:id/bookmark bookmarks the status', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/statuses/${statusId}/bookmark`, {
        method: 'POST',
        headers: authHeaders(other.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.bookmarked).toBe(true);
    });

    it('GET /api/v1/bookmarks includes the bookmarked status', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/bookmarks`, {
        headers: authHeaders(other.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
      const found = body.some((s: any) => s.id === statusId);
      expect(found).toBe(true);
    });

    it('POST /api/v1/statuses/:id/unbookmark unbookmarks the status', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/statuses/${statusId}/unbookmark`, {
        method: 'POST',
        headers: authHeaders(other.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.bookmarked).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Context
  // -------------------------------------------------------------------
  describe('GET /api/v1/statuses/:id/context', () => {
    it('returns thread context with ancestors and descendants', async () => {
      // Create a reply to form a thread
      const replyRes = await SELF.fetch(`${BASE}/api/v1/statuses`, {
        method: 'POST',
        headers: authHeaders(other.token),
        body: JSON.stringify({
          status: 'This is a reply',
          in_reply_to_id: statusId,
        }),
      });
      expect(replyRes.status).toBe(200);
      const reply = await replyRes.json<Record<string, any>>();

      const res = await SELF.fetch(`${BASE}/api/v1/statuses/${reply.id}/context`, {
        headers: authHeaders(other.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.ancestors).toBeDefined();
      expect(body.descendants).toBeDefined();
      expect(Array.isArray(body.ancestors)).toBe(true);
      expect(Array.isArray(body.descendants)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // favourited_by / reblogged_by
  // -------------------------------------------------------------------
  describe('favourited_by and reblogged_by', () => {
    it('GET /api/v1/statuses/:id/favourited_by returns a list', async () => {
      // Favourite the status first
      await SELF.fetch(`${BASE}/api/v1/statuses/${statusId}/favourite`, {
        method: 'POST',
        headers: authHeaders(other.token),
      });

      const res = await SELF.fetch(`${BASE}/api/v1/statuses/${statusId}/favourited_by`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
    });

    it('GET /api/v1/statuses/:id/reblogged_by returns a list', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/statuses/${statusId}/reblogged_by`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------
  describe('DELETE /api/v1/statuses/:id', () => {
    let deletableId: string;

    beforeAll(async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({ status: 'To be deleted' }),
      });
      const body = await res.json<Record<string, any>>();
      deletableId = body.id;
    });

    it('deletes the status and returns it', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/statuses/${deletableId}`, {
        method: 'DELETE',
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.id).toBe(deletableId);
    });

    it('returns 404 after deletion', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/statuses/${deletableId}`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(404);
    });
  });
});
