import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';
const DOMAIN = 'test.siliconbeest.local';

describe('Featured Collections (ActivityPub)', () => {
  let user: { accountId: string; userId: string; token: string };

  beforeAll(async () => {
    await applyMigration();
    // pinned column is now included in helpers.ts CREATE TABLE
    user = await createTestUser('featureduser');
  });

  // -------------------------------------------------------------------
  // Featured (Pinned Posts)
  // -------------------------------------------------------------------
  describe('GET /users/:username/collections/featured', () => {
    it('returns an OrderedCollection', async () => {
      const res = await SELF.fetch(`${BASE}/users/featureduser/collections/featured`, {
        headers: { Accept: 'application/activity+json' },
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();

      // Fedify includes extended @context with extra namespaces
      expect(body['@context']).toBeDefined();
      expect(Array.isArray(body['@context'])).toBe(true);
      expect(body['@context'][0]).toBe('https://www.w3.org/ns/activitystreams');
      expect(body.type).toBe('OrderedCollection');
      expect(body.id).toBe(`https://${DOMAIN}/users/featureduser/collections/featured`);
      // Fedify omits orderedItems when empty (no items to show)
    });

    it('includes pinned statuses in the collection', async () => {
      // Create a status and pin it
      const createRes = await SELF.fetch(`${BASE}/api/v1/statuses`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({ status: 'This is a pinned post!', visibility: 'public' }),
      });
      expect(createRes.status).toBe(200);
      const status = await createRes.json<Record<string, any>>();

      // Pin the status directly in DB
      await env.DB.prepare('UPDATE statuses SET pinned = 1 WHERE id = ?1').bind(status.id).run();

      const res = await SELF.fetch(`${BASE}/users/featureduser/collections/featured`, {
        headers: { Accept: 'application/activity+json' },
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();

      expect(body.orderedItems.length).toBe(1);
      expect(body.orderedItems[0].type).toBe('Note');
      expect(body.orderedItems[0].content).toContain('pinned post');
    });

    it('returns 404 for unknown user', async () => {
      // Fedify returns 404 for featured/tags collections of unknown users
      const res = await SELF.fetch(`${BASE}/users/nonexistent_user/collections/featured`, {
        headers: { Accept: 'application/activity+json' },
      });

      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // Featured Tags
  // -------------------------------------------------------------------
  describe('GET /users/:username/collections/tags', () => {
    it('returns an empty OrderedCollection', async () => {
      const res = await SELF.fetch(`${BASE}/users/featureduser/collections/tags`, {
        headers: { Accept: 'application/activity+json' },
      });

      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();

      // Fedify includes extended @context
      expect(body['@context']).toBeDefined();
      expect(Array.isArray(body['@context'])).toBe(true);
      expect(body['@context'][0]).toBe('https://www.w3.org/ns/activitystreams');
      expect(body.type).toBe('OrderedCollection');
      expect(body.id).toBe(`https://${DOMAIN}/users/featureduser/collections/tags`);
      // Fedify omits orderedItems when empty
    });

    it('returns 404 for unknown user', async () => {
      // Fedify returns 404 for featured/tags collections of unknown users
      const res = await SELF.fetch(`${BASE}/users/nonexistent_user/collections/tags`, {
        headers: { Accept: 'application/activity+json' },
      });

      expect(res.status).toBe(404);
    });
  });
});
