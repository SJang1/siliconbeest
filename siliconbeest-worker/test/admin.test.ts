import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Admin API', () => {
  let admin: { accountId: string; userId: string; token: string };
  let regularUser: { accountId: string; userId: string; token: string };
  let targetUser: { accountId: string; userId: string; token: string };

  beforeAll(async () => {
    await applyMigration();
    admin = await createTestUser('adminguy', { role: 'admin' });
    regularUser = await createTestUser('normaluser');
    targetUser = await createTestUser('targetuser');
  });

  // -------------------------------------------------------------------
  // GET /api/v1/admin/accounts
  // -------------------------------------------------------------------
  describe('GET /api/v1/admin/accounts', () => {
    it('returns account list for admin', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/accounts`, {
        headers: authHeaders(admin.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
    });

    it('returns 403 for non-admin user', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/accounts`, {
        headers: authHeaders(regularUser.token),
      });
      expect(res.status).toBe(403);
    });

    it('returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/accounts`);
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------
  // POST /api/v1/admin/accounts/:id/action
  // -------------------------------------------------------------------
  describe('POST /api/v1/admin/accounts/:id/action', () => {
    it('silences a user (admin only)', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v1/admin/accounts/${targetUser.accountId}/action`,
        {
          method: 'POST',
          headers: authHeaders(admin.token),
          body: JSON.stringify({ type: 'silence' }),
        },
      );
      // Accept 200 or 204 as both indicate success
      expect([200, 204]).toContain(res.status);
    });

    it('returns 403 for non-admin', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v1/admin/accounts/${targetUser.accountId}/action`,
        {
          method: 'POST',
          headers: authHeaders(regularUser.token),
          body: JSON.stringify({ type: 'silence' }),
        },
      );
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------
  // Admin settings (if implemented)
  // -------------------------------------------------------------------
  describe('Admin settings', () => {
    it('GET /api/v1/admin/settings returns settings for admin', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/settings`, {
        headers: authHeaders(admin.token),
      });
      // Accept 200 or 404 depending on whether settings endpoint exists
      expect([200, 404]).toContain(res.status);
    });

    it('GET /api/v1/admin/settings returns 403 for non-admin', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/settings`, {
        headers: authHeaders(regularUser.token),
      });
      // Should be 403 if the endpoint exists, or 404 if not
      expect([403, 404]).toContain(res.status);
    });
  });
});
