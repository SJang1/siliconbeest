import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Follow Requests API', () => {
  let lockedUser: { accountId: string; userId: string; token: string };
  let requester: { accountId: string; userId: string; token: string };
  let requester2: { accountId: string; userId: string; token: string };

  beforeAll(async () => {
    await applyMigration();
    lockedUser = await createTestUser('lockeduser');
    requester = await createTestUser('frequester');
    requester2 = await createTestUser('frequester2');

    // Make lockedUser a locked account
    await env.DB.prepare(
      'UPDATE accounts SET locked = 1, manually_approves_followers = 1 WHERE id = ?1',
    )
      .bind(lockedUser.accountId)
      .run();
  });

  describe('Follow a locked account creates a follow request', () => {
    it('POST /api/v1/accounts/:id/follow on locked account returns requested=true', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v1/accounts/${lockedUser.accountId}/follow`,
        {
          method: 'POST',
          headers: authHeaders(requester.token),
        },
      );
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.requested).toBe(true);
    });

    it('creates a second follow request from a different user', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v1/accounts/${lockedUser.accountId}/follow`,
        {
          method: 'POST',
          headers: authHeaders(requester2.token),
        },
      );
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.requested).toBe(true);
    });
  });

  describe('GET /api/v1/follow_requests', () => {
    it('lists pending follow requests for the locked user', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/follow_requests`, {
        headers: authHeaders(lockedUser.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(2);
      const usernames = body.map((a: any) => a.username);
      expect(usernames).toContain('frequester');
      expect(usernames).toContain('frequester2');
    });

    it('returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/follow_requests`);
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/follow_requests/:id/authorize', () => {
    it('accepts a follow request and creates a follow', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v1/follow_requests/${requester.accountId}/authorize`,
        {
          method: 'POST',
          headers: authHeaders(lockedUser.token),
        },
      );
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.followed_by).toBe(true);

      // Verify follow was created in the database
      const follow = await env.DB.prepare(
        'SELECT * FROM follows WHERE account_id = ?1 AND target_account_id = ?2',
      )
        .bind(requester.accountId, lockedUser.accountId)
        .first();
      expect(follow).toBeDefined();

      // Verify follow request was removed
      const fr = await env.DB.prepare(
        'SELECT * FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2',
      )
        .bind(requester.accountId, lockedUser.accountId)
        .first();
      expect(fr).toBeNull();
    });

    it('returns 404 for non-existent follow request', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v1/follow_requests/00000000-0000-0000-0000-000000000000/authorize`,
        {
          method: 'POST',
          headers: authHeaders(lockedUser.token),
        },
      );
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/follow_requests/:id/reject', () => {
    it('rejects a follow request and removes it', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v1/follow_requests/${requester2.accountId}/reject`,
        {
          method: 'POST',
          headers: authHeaders(lockedUser.token),
        },
      );
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.followed_by).toBe(false);
      expect(body.requested).toBe(false);

      // Verify follow request was removed
      const fr = await env.DB.prepare(
        'SELECT * FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2',
      )
        .bind(requester2.accountId, lockedUser.accountId)
        .first();
      expect(fr).toBeNull();

      // Verify no follow was created
      const follow = await env.DB.prepare(
        'SELECT * FROM follows WHERE account_id = ?1 AND target_account_id = ?2',
      )
        .bind(requester2.accountId, lockedUser.accountId)
        .first();
      expect(follow).toBeNull();
    });

    it('returns 404 for non-existent follow request', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v1/follow_requests/00000000-0000-0000-0000-000000000000/reject`,
        {
          method: 'POST',
          headers: authHeaders(lockedUser.token),
        },
      );
      expect(res.status).toBe(404);
    });
  });

  describe('Follow requests list after authorize/reject', () => {
    it('returns empty list after all requests handled', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/follow_requests`, {
        headers: authHeaders(lockedUser.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(body.length).toBe(0);
    });
  });
});
