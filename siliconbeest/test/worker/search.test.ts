import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';
import { processCreate } from '../../server/worker/federation/inboxProcessors/create';

const BASE = 'https://test.siliconbeest.local';

describe('Search API', () => {
  let user: { accountId: string; userId: string; token: string };
  let other: { accountId: string; userId: string; token: string };
  let restricted: { accountId: string; userId: string; token: string };
  let searchableStatus: { id: string; uri: string };

  beforeAll(async () => {
    await applyMigration();
    user = await createTestUser('searchuser');
    other = await createTestUser('searchother');
    restricted = await createTestUser('searchrestricted');
    await env.DB.prepare(
      "UPDATE oauth_access_tokens SET scopes = 'write' WHERE user_id = ?1",
    ).bind(restricted.userId).run();

    // Create a status with a hashtag and text for searching
    const statusResponse = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({
        status: 'Searching for the best #searchtest results here',
        visibility: 'public',
      }),
    });
    expect(statusResponse.status).toBe(200);
    searchableStatus = await statusResponse.json<{ id: string; uri: string }>();
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

    it('stores remote Article objects as statuses', async () => {
      const now = new Date().toISOString();
      const remoteActorUri = 'https://article-author.example/ap/actors/alice';
      const articleUri = 'https://article-author.example/ap/articles/2026/07/long-form-post';
      await env.DB.prepare(
        `INSERT OR IGNORE INTO accounts
          (id, username, domain, display_name, note, uri, url, avatar_url, avatar_static_url,
           header_url, header_static_url, locked, bot, discoverable, manually_approves_followers,
           statuses_count, followers_count, following_count, created_at, updated_at)
         VALUES ('article_actor', 'alice', 'article-author.example', '', '', ?1,
           'https://article-author.example/@alice', '', '', '', '', 0, 0, 1, 0, 0, 0, 0, ?2, ?2)`,
      ).bind(remoteActorUri, now).run();

      await processCreate({
        type: 'Create',
        actor: remoteActorUri,
        object: {
          type: 'Article',
          id: articleUri,
          nameMap: { en: 'A long-form title', ko: '장문 제목' },
          attributedTo: remoteActorUri,
          to: 'as:Public',
          contentMap: { en: '<h1>Long-form post</h1><p>Article body</p>', ko: '<h1>장문</h1><p>본문</p>' },
          summaryMap: { en: 'A compact summary', ko: '짧은 요약' },
          url: [
            'https://article-author.example/2026/07/long-form-post',
            { type: 'Link', href: 'https://article-author.example/ko/long-form-post', hreflang: 'ko' },
          ],
          mediaType: 'text/html',
          source: { content: '## Long-form post\n\nArticle body', mediaType: 'text/markdown' },
        },
      }, user.accountId, { fanout: false, notify: false });

      const stored = await env.DB.prepare(
        'SELECT id, object_type, title, text, content, content_warning, language, url, visibility FROM statuses WHERE uri = ?1 LIMIT 1',
      ).bind(articleUri).first<{ id: string; object_type: string; title: string; text: string; content: string; content_warning: string; language: string; url: string; visibility: string }>();
      expect(stored).toMatchObject({
        object_type: 'Article',
        title: 'A long-form title',
        text: '## Long-form post\n\nArticle body',
        content: '<h1>Long-form post</h1><p>Article body</p>',
        content_warning: 'A compact summary',
        language: 'en',
        url: 'https://article-author.example/2026/07/long-form-post',
        visibility: 'public',
      });

      const articleResponse = await SELF.fetch(`${BASE}/api/v1/statuses/${stored!.id}`, {
        headers: authHeaders(user.token),
      });
      expect(articleResponse.status).toBe(200);
      const articleStatus = await articleResponse.json<Record<string, unknown>>();
      expect(articleStatus.object_type).toBe('Article');
      expect(articleStatus.title).toBe('A long-form title');
      expect(articleStatus.article_summary).toBe('A compact summary');
      expect(articleStatus.spoiler_text).toBe('');

      const permalinkResponse = await SELF.fetch(
        `${BASE}/api/v2/search?q=${encodeURIComponent(stored!.url)}&type=statuses`,
      );
      expect(permalinkResponse.status).toBe(200);
      const permalinkSearch = await permalinkResponse.json<{
        statuses: Array<{ id: string; object_type: string }>;
      }>();
      expect(permalinkSearch.statuses).toContainEqual(expect.objectContaining({
        id: stored!.id,
        object_type: 'Article',
      }));
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

    it('keeps a locally-known exact public URL available anonymously without network resolution', async () => {
      const res = await SELF.fetch(
        `${BASE}/api/v2/search?q=${encodeURIComponent(searchableStatus.uri)}&type=statuses`,
      );
      expect(res.status).toBe(200);
      const body = await res.json<{ statuses: Array<{ id: string }> }>();
      expect(body.statuses.map((status) => status.id)).toContain(searchableStatus.id);
    });

    it('resolves a long status URL without type through exact lookup instead of LIKE search', async () => {
      expect(new TextEncoder().encode(`%${searchableStatus.uri}%`).byteLength).toBeGreaterThan(50);

      const res = await SELF.fetch(
        `${BASE}/api/v2/search?q=${encodeURIComponent(searchableStatus.uri)}&resolve=true`,
        { headers: authHeaders(user.token) },
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        accounts: Array<{ id: string }>;
        statuses: Array<{ id: string }>;
        hashtags: Array<{ name: string }>;
      }>();
      expect(body.accounts).toEqual([]);
      expect(body.hashtags).toEqual([]);
      expect(body.statuses.map((status) => status.id)).toContain(searchableStatus.id);
    });

    it('returns empty LIKE-backed results for an oversized non-URL query', async () => {
      const oversizedQuery = '가'.repeat(17);
      expect(new TextEncoder().encode(`%${oversizedQuery}%`).byteLength).toBeGreaterThan(50);

      const res = await SELF.fetch(
        `${BASE}/api/v2/search?q=${encodeURIComponent(oversizedQuery)}`,
        { headers: authHeaders(user.token) },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ accounts: [], statuses: [], hashtags: [] });
    });

    it('requires an authorized user for status full-text, offset, and remote resolution modes', async () => {
      const paths = [
        '/api/v2/search?q=Searching&type=statuses',
        '/api/v2/search?q=searchuser&type=accounts&offset=0',
        `/api/v2/search?q=${encodeURIComponent(searchableStatus.uri)}&type=statuses&resolve=true`,
      ];

      for (const path of paths) {
        expect((await SELF.fetch(`${BASE}${path}`)).status).toBe(401);
      }
    });

    it('requires read:search scope for authenticated-only search modes', async () => {
      const paths = [
        '/api/v2/search?q=Searching&type=statuses',
        '/api/v2/search?q=searchuser&type=accounts&offset=0',
        `/api/v2/search?q=${encodeURIComponent(searchableStatus.uri)}&type=statuses&resolve=true`,
      ];

      for (const path of paths) {
        expect((await SELF.fetch(`${BASE}${path}`, {
          headers: authHeaders(restricted.token),
        })).status).toBe(403);
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
      const body = await res.json<{ statuses: Array<{ id: string }> }>();
      expect(body.statuses).toEqual([]);
    });
  });
});
