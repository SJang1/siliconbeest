import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';
const DOMAIN = 'test.siliconbeest.local';

describe('ActivityPub Endpoints', () => {
  let user: { accountId: string; userId: string; token: string };

  beforeAll(async () => {
    await applyMigration();
    user = await createTestUser('apuser');

    // Create a public status so the outbox has content
    await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({ status: 'Hello from ActivityPub!', visibility: 'public' }),
    });
  });

  // -------------------------------------------------------------------
  // Actor
  // -------------------------------------------------------------------
  describe('GET /users/:username (ActivityPub Actor)', () => {
    it('returns an AP Actor JSON-LD document', async () => {
      const res = await SELF.fetch(`${BASE}/users/apuser`, {
        headers: { Accept: 'application/activity+json' },
      });
      expect(res.status).toBe(200);

      const ct = res.headers.get('Content-Type') ?? '';
      expect(ct).toContain('activity+json');

      const body = await res.json<Record<string, any>>();
      expect(body.type).toBe('Person');
      expect(body.preferredUsername).toBe('apuser');
      expect(body.id).toBe(`https://${DOMAIN}/users/apuser`);
    });

    it('has required ActivityPub properties', async () => {
      const res = await SELF.fetch(`${BASE}/users/apuser`, {
        headers: { Accept: 'application/activity+json' },
      });
      const body = await res.json<Record<string, any>>();

      expect(body.publicKey).toBeDefined();
      expect(body.publicKey.id).toContain('#main-key');
      expect(body.publicKey.publicKeyPem).toBeDefined();
      expect(body.inbox).toBe(`https://${DOMAIN}/users/apuser/inbox`);
      expect(body.outbox).toBe(`https://${DOMAIN}/users/apuser/outbox`);
      expect(body.followers).toBe(`https://${DOMAIN}/users/apuser/followers`);
      expect(body.following).toBe(`https://${DOMAIN}/users/apuser/following`);
    });

    it('returns 404 for unknown user', async () => {
      const res = await SELF.fetch(`${BASE}/users/nonexistent`, {
        headers: { Accept: 'application/activity+json' },
      });
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // Outbox
  // -------------------------------------------------------------------
  describe('GET /users/:username/outbox', () => {
    it('returns an OrderedCollection', async () => {
      const res = await SELF.fetch(`${BASE}/users/apuser/outbox`, {
        headers: { Accept: 'application/activity+json' },
      });
      expect(res.status).toBe(200);

      const body = await res.json<Record<string, any>>();
      expect(body.type).toBe('OrderedCollection');
      expect(typeof body.totalItems).toBe('number');
      expect(body.totalItems).toBeGreaterThanOrEqual(1);
      expect(body.first).toBeDefined();
    });

    it('returns a page with activities when ?cursor=', async () => {
      // Fedify uses ?cursor= for pagination (not ?page=true)
      const res = await SELF.fetch(`${BASE}/users/apuser/outbox?cursor=`, {
        headers: { Accept: 'application/activity+json' },
      });
      expect(res.status).toBe(200);

      const body = await res.json<Record<string, any>>();
      expect(body.type).toBe('OrderedCollectionPage');
      expect(body.orderedItems).toBeDefined();
      expect(Array.isArray(body.orderedItems)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Followers
  // -------------------------------------------------------------------
  describe('GET /users/:username/followers', () => {
    it('returns an OrderedCollection with totalItems', async () => {
      const res = await SELF.fetch(`${BASE}/users/apuser/followers`, {
        headers: { Accept: 'application/activity+json' },
      });
      expect(res.status).toBe(200);

      const body = await res.json<Record<string, any>>();
      expect(body.type).toBe('OrderedCollection');
      expect(typeof body.totalItems).toBe('number');
    });
  });

  // -------------------------------------------------------------------
  // Following
  // -------------------------------------------------------------------
  describe('GET /users/:username/following', () => {
    it('returns an OrderedCollection with totalItems', async () => {
      const res = await SELF.fetch(`${BASE}/users/apuser/following`, {
        headers: { Accept: 'application/activity+json' },
      });
      expect(res.status).toBe(200);

      const body = await res.json<Record<string, any>>();
      expect(body.type).toBe('OrderedCollection');
      expect(typeof body.totalItems).toBe('number');
    });
  });
});
