import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';
const DOMAIN = 'test.siliconbeest.local';

describe('Instance Info', () => {
  let user: { accountId: string; userId: string; token: string };

  beforeAll(async () => {
    await applyMigration();
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
