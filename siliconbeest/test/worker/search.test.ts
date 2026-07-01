import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';
import { processCreate } from '../../server/worker/federation/inboxProcessors/create';

const BASE = 'https://test.siliconbeest.local';

describe('Search API', () => {
  let user: { accountId: string; userId: string; token: string };
  let other: { accountId: string; userId: string; token: string };

  beforeAll(async () => {
    await applyMigration();
    user = await createTestUser('searchuser');
    other = await createTestUser('searchother');

    // Create a status with a hashtag and text for searching
    await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({
        status: 'Searching for the best #searchtest results here',
        visibility: 'public',
      }),
    });
  });

  // -------------------------------------------------------------------
  // Search accounts
  // -------------------------------------------------------------------
  describe('GET /api/v2/search?q=username', () => {
    it('finds accounts by username', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/search?q=searchuser`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.accounts).toBeDefined();
      expect(Array.isArray(body.accounts)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Search hashtags
  // -------------------------------------------------------------------
  describe('GET /api/v2/search?q=hashtag&type=hashtags', () => {
    it('finds hashtags', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/search?q=searchtest&type=hashtags`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.hashtags).toBeDefined();
      expect(Array.isArray(body.hashtags)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Search statuses
  // -------------------------------------------------------------------
  describe('GET /api/v2/search?q=content&type=statuses', () => {
    it('finds statuses by content', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/search?q=Searching&type=statuses`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.statuses).toBeDefined();
      expect(Array.isArray(body.statuses)).toBe(true);
    });

    it('stores compact as:Public remote statuses as public', async () => {
      const now = new Date().toISOString();
      const remoteActorUri = 'https://compact-public.example/users/alice';
      await env.DB.prepare(
        `INSERT OR IGNORE INTO accounts
          (id, username, domain, display_name, note, uri, url, avatar_url, avatar_static_url,
           header_url, header_static_url, locked, bot, discoverable, manually_approves_followers,
           statuses_count, followers_count, following_count, created_at, updated_at)
         VALUES ('compact_public_actor', 'alice', 'compact-public.example', '', '', ?1,
           'https://compact-public.example/@alice', '', '', '', '', 0, 0, 1, 0, 0, 0, 0, ?2, ?2)`,
      ).bind(remoteActorUri, now).run();

      await processCreate({
        type: 'Create',
        actor: remoteActorUri,
        object: {
          type: 'Note',
          id: 'https://compact-public.example/users/alice/statuses/1',
          attributedTo: remoteActorUri,
          to: 'as:Public',
          cc: `${remoteActorUri}/followers`,
          content: '<p>compact public</p>',
        },
      }, user.accountId, { fanout: false, notify: false });

      const stored = await env.DB.prepare(
        'SELECT visibility FROM statuses WHERE uri = ?1 LIMIT 1',
      ).bind('https://compact-public.example/users/alice/statuses/1').first<{ visibility: string }>();
      expect(stored?.visibility).toBe('public');
    });

    it('does not return private or direct statuses by URL to unauthorized users', async () => {
      const privateRes = await SELF.fetch(`${BASE}/api/v1/statuses`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          status: 'private url lookup should stay hidden',
          visibility: 'private',
        }),
      });
      expect(privateRes.status).toBe(200);
      const privateStatus = await privateRes.json<Record<string, any>>();

      const directRes = await SELF.fetch(`${BASE}/api/v1/statuses`, {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          status: 'direct url lookup should stay hidden',
          visibility: 'direct',
        }),
      });
      expect(directRes.status).toBe(200);
      const directStatus = await directRes.json<Record<string, any>>();

      for (const status of [privateStatus, directStatus]) {
        const res = await SELF.fetch(`${BASE}/api/v2/search?q=${encodeURIComponent(status.uri)}&type=statuses&resolve=true`, {
          headers: authHeaders(other.token),
        });
        expect(res.status).toBe(200);
        const body = await res.json<Record<string, any>>();
        expect(body.statuses.some((item: Record<string, any>) => item.id === status.id)).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------
  // Search structure
  // -------------------------------------------------------------------
  describe('Search response structure', () => {
    it('returns all three result arrays', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/search?q=test`, {
        headers: authHeaders(user.token),
      });
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, any>>();
      expect(body.accounts).toBeDefined();
      expect(body.statuses).toBeDefined();
      expect(body.hashtags).toBeDefined();
    });

    it('allows search without auth (public search)', async () => {
      const res = await SELF.fetch(`${BASE}/api/v2/search?q=test`);
      expect(res.status).toBe(200);
    });
  });
});
