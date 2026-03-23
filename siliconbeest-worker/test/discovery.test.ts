import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';
const DOMAIN = 'test.siliconbeest.local';

describe('Federation Discovery', () => {
  beforeAll(async () => {
    await applyMigration();
    await createTestUser('discoverable');
  });

  // -------------------------------------------------------------------
  // WebFinger
  // -------------------------------------------------------------------
  describe('GET /.well-known/webfinger', () => {
    it('returns JRD+JSON for a known user', async () => {
      const res = await SELF.fetch(
        `${BASE}/.well-known/webfinger?resource=acct:discoverable@${DOMAIN}`,
      );
      expect(res.status).toBe(200);

      const ct = res.headers.get('Content-Type') ?? '';
      expect(ct).toContain('jrd+json');

      const body = await res.json<Record<string, any>>();
      expect(body.subject).toBe(`acct:discoverable@${DOMAIN}`);
      expect(body.links).toBeDefined();
      expect(Array.isArray(body.links)).toBe(true);

      const selfLink = body.links.find((l: any) => l.rel === 'self');
      expect(selfLink).toBeDefined();
      expect(selfLink.type).toBe('application/activity+json');
      expect(selfLink.href).toBe(`https://${DOMAIN}/users/discoverable`);
    });

    it('returns 404 for an unknown user', async () => {
      const res = await SELF.fetch(
        `${BASE}/.well-known/webfinger?resource=acct:nobody@${DOMAIN}`,
      );
      expect(res.status).toBe(404);
    });

    it('returns 400 without resource parameter', async () => {
      const res = await SELF.fetch(`${BASE}/.well-known/webfinger`);
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid resource format', async () => {
      const res = await SELF.fetch(
        `${BASE}/.well-known/webfinger?resource=invalid`,
      );
      expect(res.status).toBe(400);
    });

    it('returns 404 for a different domain', async () => {
      const res = await SELF.fetch(
        `${BASE}/.well-known/webfinger?resource=acct:user@other.example.com`,
      );
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // NodeInfo
  // -------------------------------------------------------------------
  describe('GET /.well-known/nodeinfo', () => {
    it('returns nodeinfo links', async () => {
      const res = await SELF.fetch(`${BASE}/.well-known/nodeinfo`);
      expect(res.status).toBe(200);

      const body = await res.json<Record<string, any>>();
      expect(body.links).toBeDefined();
      expect(Array.isArray(body.links)).toBe(true);
      expect(body.links.length).toBeGreaterThanOrEqual(1);

      const link = body.links[0];
      expect(link.rel).toBe('http://nodeinfo.diaspora.software/ns/schema/2.0');
      expect(link.href).toBe(`https://${DOMAIN}/nodeinfo/2.0`);
    });
  });

  describe('GET /nodeinfo/2.0', () => {
    it('returns instance metadata with siliconbeest software name', async () => {
      const res = await SELF.fetch(`${BASE}/nodeinfo/2.0`);
      expect(res.status).toBe(200);

      const body = await res.json<Record<string, any>>();
      expect(body.version).toBe('2.0');
      expect(body.software).toBeDefined();
      expect(body.software.name).toBe('siliconbeest');
      expect(body.protocols).toContain('activitypub');
      expect(body.openRegistrations).toBe(true);
      expect(body.usage).toBeDefined();
      expect(body.usage.users).toBeDefined();
      expect(typeof body.usage.localPosts).toBe('number');
    });
  });

  // -------------------------------------------------------------------
  // Host-Meta
  // -------------------------------------------------------------------
  describe('GET /.well-known/host-meta', () => {
    it('returns XRD XML', async () => {
      const res = await SELF.fetch(`${BASE}/.well-known/host-meta`);
      expect(res.status).toBe(200);

      const ct = res.headers.get('Content-Type') ?? '';
      expect(ct).toContain('xrd+xml');

      const body = await res.text();
      expect(body).toContain('<?xml');
      expect(body).toContain('XRD');
      expect(body).toContain('webfinger');
      expect(body).toContain(DOMAIN);
    });
  });
});
