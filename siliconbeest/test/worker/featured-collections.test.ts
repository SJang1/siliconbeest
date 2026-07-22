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

    it('includes only public pinned statuses in the unsigned collection', async () => {
      const createRes = await SELF.fetch(`${BASE}/api/v1/statuses`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({ status: 'This is a pinned post!', visibility: 'public' }),
      });
      expect(createRes.status).toBe(200);
      const status = await createRes.json<{ id: string }>();

      const privateRes = await SELF.fetch(`${BASE}/api/v1/statuses`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({ status: 'private pinned secret', visibility: 'private' }),
      });
      expect(privateRes.status).toBe(200);
      const privateStatus = await privateRes.json<{ id: string }>();
      const privatePin = await SELF.fetch(
        `${BASE}/api/v1/statuses/${privateStatus.id}/pin`,
        { method: 'POST', headers: authHeaders(user.token) },
      );
      expect(privatePin.status).toBe(200);

      const directRes = await SELF.fetch(`${BASE}/api/v1/statuses`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({ status: 'direct pinned secret', visibility: 'direct' }),
      });
      expect(directRes.status).toBe(200);
      const directStatus = await directRes.json<{ id: string }>();

      // Direct pins are invalid now, but legacy rows must also fail closed.
      await env.DB_META_C000.prepare(
        'UPDATE statuses SET pinned = 1 WHERE id IN (?1, ?2)',
      ).bind(status.id, directStatus.id).run();

      const res = await SELF.fetch(`${BASE}/users/featureduser/collections/featured`, {
        headers: { Accept: 'application/activity+json' },
      });

      expect(res.status).toBe(200);
      const body = await res.json<{
        orderedItems: Array<{ type: string; content: string }>;
      }>();

      expect(body.orderedItems.length).toBe(1);
      expect(body.orderedItems[0].type).toBe('Note');
      expect(body.orderedItems[0].content).toContain('pinned post');
      expect(JSON.stringify(body)).not.toContain('private pinned secret');
      expect(JSON.stringify(body)).not.toContain('direct pinned secret');
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
