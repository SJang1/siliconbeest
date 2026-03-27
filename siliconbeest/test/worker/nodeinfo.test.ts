import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';
const DOMAIN = 'test.siliconbeest.local';

describe('NodeInfo', () => {
  beforeAll(async () => {
    await applyMigration();
    // Create a test user so stats are non-zero
    await createTestUser('nodeinfouser');
  });

  // -------------------------------------------------------------------
  // /.well-known/nodeinfo
  // -------------------------------------------------------------------
  describe('GET /.well-known/nodeinfo', () => {
    it('returns links array with at least nodeinfo 2.1 endpoint', async () => {
      const res = await SELF.fetch(`${BASE}/.well-known/nodeinfo`);

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();

      expect(body.links).toBeDefined();
      expect(Array.isArray(body.links)).toBe(true);
      expect(body.links.length).toBeGreaterThanOrEqual(1);

      const link21 = body.links.find(
        (l: any) => l.rel === 'http://nodeinfo.diaspora.software/ns/schema/2.1',
      );
      expect(link21).toBeDefined();
      expect(link21.href).toBe(`https://${DOMAIN}/nodeinfo/2.1`);
    });
  });

  // -------------------------------------------------------------------
  // /nodeinfo/2.1
  // -------------------------------------------------------------------
  describe('GET /nodeinfo/2.1', () => {
    it('returns valid NodeInfo with software name and version', async () => {
      const res = await SELF.fetch(`${BASE}/nodeinfo/2.1`);

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();

      expect(body.version).toBe('2.1');
      expect(body.software).toBeDefined();
      expect(body.software.name).toBe('siliconbeest');
      expect(body.software.version).toBeDefined();
      expect(typeof body.software.version).toBe('string');
    });

    it('includes protocols array with activitypub', () => {
      return SELF.fetch(`${BASE}/nodeinfo/2.1`).then(async (res) => {
        const body = await res.json<Record<string, any>>();

        expect(body.protocols).toEqual(['activitypub']);
      });
    });

    it('includes usage stats fields', async () => {
      const res = await SELF.fetch(`${BASE}/nodeinfo/2.1`);
      const body = await res.json<Record<string, any>>();

      expect(body.usage).toBeDefined();
      expect(body.usage.users).toBeDefined();
      expect(typeof body.usage.users.total).toBe('number');
      expect(typeof body.usage.users.activeMonth).toBe('number');
      expect(typeof body.usage.users.activeHalfyear).toBe('number');
      expect(typeof body.usage.localPosts).toBe('number');
      expect(typeof body.usage.localComments).toBe('number');
    });

    it('has user count of at least 1 after creating a user', async () => {
      const res = await SELF.fetch(`${BASE}/nodeinfo/2.1`);
      const body = await res.json<Record<string, any>>();

      expect(body.usage.users.total).toBeGreaterThanOrEqual(1);
    });

    it('openRegistrations matches setting (open)', async () => {
      const res = await SELF.fetch(`${BASE}/nodeinfo/2.1`);
      const body = await res.json<Record<string, any>>();

      // vitest.config binds REGISTRATION_MODE = 'open'
      expect(body.openRegistrations).toBe(true);
    });

    it('includes services with inbound and outbound arrays', async () => {
      const res = await SELF.fetch(`${BASE}/nodeinfo/2.1`);
      const body = await res.json<Record<string, any>>();

      expect(body.services).toBeDefined();
      expect(Array.isArray(body.services.inbound)).toBe(true);
      expect(Array.isArray(body.services.outbound)).toBe(true);
    });

    it('includes metadata with nodeName', async () => {
      const res = await SELF.fetch(`${BASE}/nodeinfo/2.1`);
      const body = await res.json<Record<string, any>>();

      expect(body.metadata).toBeDefined();
      expect(body.metadata.nodeName).toBeDefined();
    });

    it('returns correct Content-Type header with profile', async () => {
      const res = await SELF.fetch(`${BASE}/nodeinfo/2.1`);
      const ct = res.headers.get('Content-Type') ?? '';

      expect(ct).toContain('application/json');
      expect(ct).toContain('nodeinfo.diaspora.software/ns/schema/2.1');
    });
  });

  // -------------------------------------------------------------------
  // /nodeinfo/2.0 (backward compatibility)
  // -------------------------------------------------------------------
  describe('GET /nodeinfo/2.0', () => {
    it('returns version 2.0 with basic fields', async () => {
      const res = await SELF.fetch(`${BASE}/nodeinfo/2.0`);

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();

      expect(body.version).toBe('2.0');
      expect(body.software.name).toBe('siliconbeest');
      expect(body.protocols).toEqual(['activitypub']);
      expect(body.usage).toBeDefined();
      expect(typeof body.openRegistrations).toBe('boolean');
    });
  });
});
