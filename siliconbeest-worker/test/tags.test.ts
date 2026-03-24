import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Tags API', () => {
  let user: { accountId: string; userId: string; token: string };
  let tagId: string;

  beforeAll(async () => {
    await applyMigration();
    user = await createTestUser('taguser');

    // Create a tag directly in the database
    tagId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO tags (id, name, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)',
    )
      .bind(tagId, 'testtag', 'TestTag', now)
      .run();
  });

  describe('GET /api/v1/tags/:id', () => {
    it('returns tag info', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/tags/testtag`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.name).toBe('testtag');
      expect(body.url).toContain('/tags/testtag');
      expect(body.following).toBe(false);
    });

    it('returns 404 for non-existent tag', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/tags/nonexistenttag`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(404);
    });

    it('works without auth (auth optional)', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/tags/testtag`);
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.name).toBe('testtag');
      expect(body.following).toBe(false);
    });
  });

  describe('POST /api/v1/tags/:id/follow', () => {
    it('follows a tag', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/tags/testtag/follow`, {
        method: 'POST',
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.name).toBe('testtag');
      expect(body.following).toBe(true);
    });

    it('is idempotent (following again succeeds)', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/tags/testtag/follow`, {
        method: 'POST',
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.following).toBe(true);
    });

    it('returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/tags/testtag/follow`, {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });

    it('returns 404 for non-existent tag', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v1/tags/nonexistenttag/follow`,
        {
          method: 'POST',
          headers: authHeaders(user.token),
        },
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/tags/:id after following', () => {
    it('shows following=true for followed tag', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/tags/testtag`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.following).toBe(true);
    });
  });

  describe('POST /api/v1/tags/:id/unfollow', () => {
    it('unfollows a tag', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/tags/testtag/unfollow`, {
        method: 'POST',
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.name).toBe('testtag');
      expect(body.following).toBe(false);
    });

    it('returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/tags/testtag/unfollow`, {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });

    it('returns 404 for non-existent tag', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v1/tags/nonexistenttag/unfollow`,
        {
          method: 'POST',
          headers: authHeaders(user.token),
        },
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/tags/:id after unfollowing', () => {
    it('shows following=false after unfollowing', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/tags/testtag`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.following).toBe(false);
    });
  });
});
