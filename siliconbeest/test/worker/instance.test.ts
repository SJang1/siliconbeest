import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';
const DOMAIN = 'test.siliconbeest.local';

describe('Instance Info', () => {
  let user: { accountId: string; userId: string; token: string };

  beforeAll(async () => {
    await applyMigration();
    await env.CACHE.put('settings:instance_languages', JSON.stringify(['ko', 'en']));
    user = await createTestUser('instuser');
  });

  // -------------------------------------------------------------------
  // GET /api/v2/instance
  // -------------------------------------------------------------------
  describe('GET /api/v2/instance', () => {
    it('returns instance info', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/instance`);
      expect(res.status).toBe(200);

      const body = await res.json<Record<string, any>>();
      expect(body.domain).toBe(DOMAIN);
      expect(body.title).toBeDefined();
      expect(body.version).toBeDefined();
      expect(body.version).toContain('SiliconBeest');
    });

    it('includes registration info', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/instance`);
      const body = await res.json<Record<string, any>>();

      expect(body.registrations).toBeDefined();
      expect(typeof body.registrations.enabled).toBe('boolean');
      // REGISTRATION_MODE is 'open' in test config
      expect(body.registrations.enabled).toBe(true);
    });

    it('includes the server-configured languages', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/instance`);
      const body = await res.json<Record<string, any>>();

      expect(body.languages).toEqual(['ko', 'en']);
    });

    it('falls back to English when the language KV value is not JSON', async () => {
      await env.CACHE.put('settings:instance_languages', 'not-json');
      try {
        const res = await SELF.fetch(`${BASE}/api/v2/instance`);
        expect(res.status).toBe(200);
        const body = await res.json<Record<string, any>>();
        expect(body.languages).toEqual(['en']);
      } finally {
        await env.CACHE.put('settings:instance_languages', JSON.stringify(['ko', 'en']));
      }
    });

    it('uses the server-configured logo URL as thumbnail', async () => {
      const thumbnailUrl = 'https://cdn.example.com/instance-logo-v2.png';
      await env.DB_META_C000.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('site_logo_url', ?1, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).bind(thumbnailUrl).run();

      const res = await SELF.fetch(`${BASE}/api/v2/instance`);
      const body = await res.json<Record<string, any>>();
      expect(body.thumbnail.url).toBe(thumbnailUrl);
    });

    it('includes configuration section', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/instance`);
      const body = await res.json<Record<string, any>>();

      expect(body.configuration).toBeDefined();
      expect(body.configuration.statuses).toBeDefined();
      expect(body.configuration.statuses.max_characters).toBe(500);
      expect(body.configuration.media_attachments).toBeDefined();
      expect(body.configuration.polls).toBeDefined();
    });

    it('includes rules array', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/instance`);
      const body = await res.json<Record<string, any>>();

      expect(body.rules).toBeDefined();
      expect(Array.isArray(body.rules)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // GET /api/v1/custom_emojis
  // -------------------------------------------------------------------
  describe('GET /api/v1/custom_emojis', () => {
    it('returns an array of custom emojis', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/custom_emojis`);
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // GET /api/v1/instance/rules
  // -------------------------------------------------------------------
  describe('GET /api/v1/instance/rules', () => {
    it('returns an array of rules', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/instance/rules`);
      expect(res.status).toBe(200);
      const body = await res.json<any[]>();
      expect(Array.isArray(body)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // GET /api/v1/preferences
  // -------------------------------------------------------------------
  describe('GET /api/v1/preferences', () => {
    it('returns preferences for the authenticated user', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/preferences`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(typeof body).toBe('object');
    });

    it('returns 401 without auth', async () => {
      const res = await SELF.fetch(`${BASE}/api/v1/preferences`);
      expect(res.status).toBe(401);
    });
  });
});
