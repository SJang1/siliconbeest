import { env, SELF } from 'cloudflare:test';
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

    it('stores the three Workers AI switches independently without a migration seed', async () => {
      const before = await SELF.fetch(`${BASE}/api/v1/admin/settings`, {
        headers: authHeaders(admin.token),
      });
      expect(before.status).toBe(200);
      expect(await before.json<Record<string, string>>()).not.toHaveProperty(
        'workers_ai_recommendation_enabled',
      );

      const response = await SELF.fetch(`${BASE}/api/v1/admin/settings`, {
        method: 'PATCH',
        headers: authHeaders(admin.token),
        body: JSON.stringify({
          workers_ai_recommendation_enabled: '1',
          workers_ai_translation_enabled: '0',
          workers_ai_image_description_enabled: '1',
        }),
      });
      expect(response.status).toBe(200);
      await expect(response.json<Record<string, string>>()).resolves.toMatchObject({
        workers_ai_recommendation_enabled: '1',
        workers_ai_translation_enabled: '0',
        workers_ai_image_description_enabled: '1',
      });

      const instanceResponse = await SELF.fetch(`${BASE}/api/v2/instance`);
      const instance = await instanceResponse.json<{
        configuration: {
          translation: { enabled: boolean };
          ai: {
            enabled: boolean;
            recommended_timeline: boolean;
            image_description: boolean;
          };
        };
      }>();
      expect(instance.configuration.translation.enabled).toBe(false);
      expect(instance.configuration.ai).toEqual({
        enabled: false,
        recommended_timeline: false,
        image_description: false,
      });

      const bindings = env as unknown as Record<string, unknown>;
      const previousEnabled = bindings.WORKERS_AI_ENABLED;
      const previousAi = bindings.AI;
      const hadEnabled = Object.prototype.hasOwnProperty.call(bindings, 'WORKERS_AI_ENABLED');
      const hadAi = Object.prototype.hasOwnProperty.call(bindings, 'AI');
      bindings.WORKERS_AI_ENABLED = true;
      bindings.AI = { run: async () => ({}) };
      try {
        const enabledResponse = await SELF.fetch(`${BASE}/api/v2/instance`);
        const enabledInstance = await enabledResponse.json<typeof instance>();
        expect(enabledInstance.configuration.translation.enabled).toBe(false);
        expect(enabledInstance.configuration.ai).toEqual({
          enabled: true,
          recommended_timeline: true,
          image_description: true,
        });
      } finally {
        if (hadEnabled) bindings.WORKERS_AI_ENABLED = previousEnabled;
        else Reflect.deleteProperty(bindings, 'WORKERS_AI_ENABLED');
        if (hadAi) bindings.AI = previousAi;
        else Reflect.deleteProperty(bindings, 'AI');
      }
    });

    it.each([
      'workers_ai_recommendation_enabled',
      'workers_ai_translation_enabled',
      'workers_ai_image_description_enabled',
    ])('rejects malformed %s values', async (key) => {
      const response = await SELF.fetch(`${BASE}/api/v1/admin/settings`, {
        method: 'PATCH',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ [key]: 'true' }),
      });
      expect(response.status).toBe(422);
    });

    it('stores instance languages in KV and exposes the normalized setting', async () => {
      const response = await SELF.fetch(`${BASE}/api/v1/admin/settings`, {
        method: 'PATCH',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ instance_languages: 'ko-kr, EN, ko-KR' }),
      });
      expect(response.status).toBe(200);
      await expect(response.json<Record<string, string>>()).resolves.toMatchObject({
        instance_languages: 'ko-KR, en',
      });

      await expect(env.CACHE.get('settings:instance_languages', 'json')).resolves.toEqual([
        'ko-KR',
        'en',
      ]);
      await expect(env.DB_META_C000.prepare(
        "SELECT value FROM settings WHERE key = 'instance_languages'",
      ).first()).resolves.toBeNull();

      const instanceResponse = await SELF.fetch(`${BASE}/api/v2/instance`);
      const instance = await instanceResponse.json<{ languages: string[] }>();
      expect(instance.languages).toEqual(['ko-KR', 'en']);
    });

    it('falls back to English for admin reads when the language KV value is not JSON', async () => {
      await env.CACHE.put('settings:instance_languages', 'not-json');
      try {
        const getResponse = await SELF.fetch(`${BASE}/api/v1/admin/settings`, {
          headers: authHeaders(admin.token),
        });
        expect(getResponse.status).toBe(200);
        const settings = await getResponse.json<Record<string, string>>();
        expect(settings).toMatchObject({
          instance_languages: 'en',
        });

        const patchResponse = await SELF.fetch(`${BASE}/api/v1/admin/settings`, {
          method: 'PATCH',
          headers: authHeaders(admin.token),
          body: JSON.stringify({}),
        });
        expect(patchResponse.status).toBe(200);
        await expect(patchResponse.json<Record<string, string>>()).resolves.toMatchObject({
          instance_languages: 'en',
        });
      } finally {
        await env.CACHE.put('settings:instance_languages', JSON.stringify(['ko-KR', 'en']));
      }
    });

    it('accepts integer settings sent as JSON numbers', async () => {
      const response = await SELF.fetch(`${BASE}/api/v1/admin/settings`, {
        method: 'PATCH',
        headers: authHeaders(admin.token),
        body: JSON.stringify({
          invite_credit_max_per_account: 25,
          invite_contribution_threshold: 40,
          invite_contribution_points_status_create: 3,
          max_toot_chars: 700,
        }),
      });
      expect(response.status).toBe(200);
      await expect(response.json<Record<string, string>>()).resolves.toMatchObject({
        invite_credit_max_per_account: '25',
        invite_contribution_threshold: '40',
        invite_contribution_points_status_create: '3',
        max_toot_chars: '700',
      });
    });

    it('rejects non-integer numeric invite_credit_max_per_account', async () => {
      const response = await SELF.fetch(`${BASE}/api/v1/admin/settings`, {
        method: 'PATCH',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ invite_credit_max_per_account: 2.5 }),
      });
      expect(response.status).toBe(422);
    });

    it.each(['', 'not_a_language'])('rejects malformed instance languages: %s', async (value) => {
      const response = await SELF.fetch(`${BASE}/api/v1/admin/settings`, {
        method: 'PATCH',
        headers: authHeaders(admin.token),
        body: JSON.stringify({ instance_languages: value }),
      });
      expect(response.status).toBe(422);
    });
  });
});
