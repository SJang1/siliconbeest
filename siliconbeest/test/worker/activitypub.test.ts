import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';
const DOMAIN = 'test.siliconbeest.local';

describe('ActivityPub Endpoints', () => {
  let user: { accountId: string; userId: string; token: string };
  let noteStatusId: string;
  let articleStatusId: string;
  let announceStatusId: string;
  let suspendedStatusId: string;

  beforeAll(async () => {
    await applyMigration();
    user = await createTestUser('apuser');
    const booster = await createTestUser('apbooster');
    const disabled = await createTestUser('apdisabled');
    const pending = await createTestUser('appending');
    const memorial = await createTestUser('apmemorial');
    const suspended = await createTestUser('apsuspended');
    await env.DB.prepare('UPDATE users SET disabled = 1 WHERE id = ?1')
      .bind(disabled.userId).run();
    await env.DB.prepare('UPDATE users SET approved = 0 WHERE id = ?1')
      .bind(pending.userId).run();
    await env.DB.prepare('UPDATE accounts SET memorial = 1 WHERE id = ?1')
      .bind(memorial.accountId).run();

    const suspendedStatus = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(suspended.token),
      body: JSON.stringify({ status: 'must disappear after suspension', visibility: 'public' }),
    });
    expect(suspendedStatus.status).toBe(200);
    suspendedStatusId = (await suspendedStatus.json<{ id: string }>()).id;
    await env.DB.batch([
      env.DB.prepare('UPDATE statuses SET pinned = 1 WHERE id = ?1')
        .bind(suspendedStatusId),
      env.DB.prepare('UPDATE accounts SET suspended_at = ?1 WHERE id = ?2')
        .bind(new Date().toISOString(), suspended.accountId),
    ]);

    // Create public objects used by the outbox and activity-wrapper tests.
    const noteStatus = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({ status: 'Hello from ActivityPub!', visibility: 'public' }),
    });
    expect(noteStatus.status).toBe(200);
    noteStatusId = (await noteStatus.json<{ id: string }>()).id;

    const articleStatus = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({
        object_type: 'Article',
        title: 'Activity wrapper article',
        summary: 'Article summary',
        status: 'Long-form ActivityPub content.',
        visibility: 'public',
      }),
    });
    expect(articleStatus.status).toBe(200);
    articleStatusId = (await articleStatus.json<{ id: string }>()).id;

    const announceStatus = await SELF.fetch(`${BASE}/api/v1/statuses/${noteStatusId}/reblog`, {
      method: 'POST',
      headers: authHeaders(booster.token),
    });
    expect(announceStatus.status).toBe(200);
    announceStatusId = (await announceStatus.json<{ id: string }>()).id;
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

    it.each(['apdisabled', 'appending', 'apmemorial'])(
      'does not expose inactive actor %s through Actor or WebFinger',
      async (username) => {
        const actor = await SELF.fetch(`${BASE}/users/${username}`, {
          headers: { Accept: 'application/activity+json' },
        });
        expect(actor.status).toBe(404);

        const webfinger = await SELF.fetch(
          `${BASE}/.well-known/webfinger?resource=acct:${username}@${DOMAIN}`,
        );
        expect(webfinger.status).toBe(404);
      },
    );

    it('publishes assertionMethod keys under fedify keyId naming', async () => {
      // Outbound FEP-8b32 integrity proofs reference `#multikey-2`
      // (fedify's positional Multikey naming); the actor document must
      // publish that exact id or remote servers cannot verify our proofs.
      const res = await SELF.fetch(`${BASE}/users/apuser`, {
        headers: { Accept: 'application/activity+json' },
      });
      const body = await res.json<Record<string, any>>();

      const methods = Array.isArray(body.assertionMethod)
        ? body.assertionMethod
        : [body.assertionMethod];
      const ids = methods.filter(Boolean).map((m: any) => (typeof m === 'string' ? m : m.id));
      expect(ids).toContain(`https://${DOMAIN}/users/apuser#multikey-2`);
      for (const m of methods.filter((m: any) => m && typeof m !== 'string')) {
        expect(m.type).toBe('Multikey');
        expect(m.controller).toBe(`https://${DOMAIN}/users/apuser`);
        expect(m.publicKeyMultibase).toBeDefined();
      }
    });
  });

  // -------------------------------------------------------------------
  // Activity wrappers
  // -------------------------------------------------------------------
  describe('GET /users/:username/statuses/:id/activity', () => {
    it('returns Create(Note) for a regular status', async () => {
      const res = await SELF.fetch(`${BASE}/users/apuser/statuses/${noteStatusId}/activity`, {
        headers: { Accept: 'application/activity+json' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('activity+json');

      const activity = await res.json<Record<string, any>>();
      expect(activity.type).toBe('Create');
      expect(activity.object?.type).toBe('Note');
      expect(activity.object?.id).toBe(`${BASE}/users/apuser/statuses/${noteStatusId}`);
    });

    it('returns Create(Article) for a long-form status', async () => {
      const res = await SELF.fetch(`${BASE}/users/apuser/statuses/${articleStatusId}/activity`, {
        headers: { Accept: 'application/activity+json' },
      });
      expect(res.status).toBe(200);

      const activity = await res.json<Record<string, any>>();
      expect(activity.type).toBe('Create');
      expect(activity.object?.type).toBe('Article');
      expect(activity.object?.name).toBe('Activity wrapper article');
    });

    it('returns Announce for a reblog', async () => {
      const res = await SELF.fetch(`${BASE}/users/apbooster/statuses/${announceStatusId}/activity`, {
        headers: { Accept: 'application/activity+json' },
      });
      expect(res.status).toBe(200);

      const activity = await res.json<Record<string, any>>();
      expect(activity.type).toBe('Announce');
      expect(activity.object).toBe(`${BASE}/users/apuser/statuses/${noteStatusId}`);
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

    it('fails closed for every child resource of a suspended local actor', async () => {
      const paths = [
        `/users/apsuspended/statuses/${suspendedStatusId}`,
        `/users/apsuspended/statuses/${suspendedStatusId}/activity`,
        `/users/apsuspended/statuses/${suspendedStatusId}/replies`,
        `/users/apsuspended/statuses/${suspendedStatusId}/shares`,
        `/users/apsuspended/statuses/${suspendedStatusId}/likes`,
        '/users/apsuspended/outbox',
        '/users/apsuspended/collections/featured',
        '/users/apsuspended/collections/tags',
        '/users/apsuspended/followers',
        '/users/apsuspended/following',
      ];

      for (const path of paths) {
        const res = await SELF.fetch(`${BASE}${path}`, {
          headers: { Accept: 'application/activity+json, application/ld+json' },
        });
        expect([401, 404]).toContain(res.status);
      }
    });

    it('does not expose the unadvertised liked collection', async () => {
      const res = await SELF.fetch(`${BASE}/users/apuser/liked`, {
        headers: { Accept: 'application/activity+json' },
      });
      expect(res.status).toBe(404);
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
