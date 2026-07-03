import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Instance accent color', () => {
  let admin: { accountId: string; userId: string; token: string };
  let user: { accountId: string; userId: string; token: string };

  beforeAll(async () => {
    await applyMigration();
    admin = await createTestUser('accentadmin', { role: 'admin' });
    user = await createTestUser('accentuser');
  });

  describe('PATCH /api/v1/admin/settings', () => {
    it('accepts a valid #rrggbb accent_color', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/settings`, {
        method: 'PATCH',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ accent_color: '#4ed9c6' }),
      });
      expect(res.status).toBe(200);
      const settings = (await res.json()) as Record<string, string>;
      expect(settings.accent_color).toBe('#4ed9c6');
    });

    it('rejects a non-hex accent_color with 422', async () => {
      for (const bad of ['red', '#fff', '#c6f24e00', 'c6f24e']) {
        const res = await SELF.fetch(`${BASE}/api/v1/admin/settings`, {
          method: 'PATCH',
          headers: authHeaders(admin.token),
          body: JSON.stringify({ accent_color: bad }),
        });
        expect(res.status, `accent_color=${bad}`).toBe(422);
      }
    });

    it('rejects non-admin users', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/settings`, {
        method: 'PATCH',
        headers: authHeaders(user.token),
        body: JSON.stringify({ accent_color: '#c6f24e' }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/v2/instance', () => {
    it('exposes accent_color to unauthenticated visitors', async () => {
      await SELF.fetch(`${BASE}/api/v1/admin/settings`, {
        method: 'PATCH',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ accent_color: '#ff8a5c' }),
      });

      const res = await SELF.fetch(`${BASE}/api/v2/instance`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { accent_color: string | null };
      expect(body.accent_color).toBe('#ff8a5c');
    });
  });
});
