import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

type StatusEntity = {
  id: string;
  reblog: { id: string } | null;
};

type SearchEntity = {
  statuses: StatusEntity[];
};

describe('canonical boost wrapper permissions', () => {
  let viewer: Awaited<ReturnType<typeof createTestUser>>;
  let originalAuthor: Awaited<ReturnType<typeof createTestUser>>;

  const ids = {
    original: 'canonical-boost-original',
    wrapper: 'canonical-boost-wrapper',
    remoteAuthor: 'canonical-boost-remote-author',
    remoteOriginal: 'canonical-boost-remote-original',
    remoteWrapper: 'canonical-boost-remote-wrapper',
  } as const;

  beforeAll(async () => {
    await applyMigration();
    viewer = await createTestUser('canonical_boost_viewer');
    originalAuthor = await createTestUser('canonical_boost_original_author');
    const now = new Date().toISOString();

    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare(
        `INSERT INTO accounts
          (id, username, domain, display_name, note, uri, url, created_at, updated_at)
         VALUES (?1, 'remote_original', 'blocked.example', 'Remote original', '', ?2, ?2, ?3, ?3)`,
      ).bind(
        ids.remoteAuthor,
        'https://blocked.example/users/remote_original',
        now,
      ),
      env.DB_META_C000.prepare(
        `INSERT INTO statuses
          (id, uri, url, account_id, content, visibility, local, created_at, updated_at)
         VALUES (?1, ?2, ?2, ?3, '<p>local original</p>', 'public', 1, ?4, ?4)`,
      ).bind(
        ids.original,
        `${BASE}/statuses/${ids.original}`,
        originalAuthor.accountId,
        now,
      ),
      env.DB_META_C000.prepare(
        `INSERT INTO statuses
          (id, uri, url, account_id, reblog_of_id, visibility, local, created_at, updated_at)
         VALUES (?1, ?2, ?2, ?3, ?4, 'public', 1, ?5, ?5)`,
      ).bind(
        ids.wrapper,
        `${BASE}/statuses/${ids.wrapper}`,
        viewer.accountId,
        ids.original,
        now,
      ),
      env.DB_META_C000.prepare(
        `INSERT INTO statuses
          (id, uri, url, account_id, content, visibility, local, created_at, updated_at)
         VALUES (?1, ?2, ?2, ?3, '<p>remote original</p>', 'public', 0, ?4, ?4)`,
      ).bind(
        ids.remoteOriginal,
        `https://blocked.example/statuses/${ids.remoteOriginal}`,
        ids.remoteAuthor,
        now,
      ),
      env.DB_META_C000.prepare(
        `INSERT INTO statuses
          (id, uri, url, account_id, reblog_of_id, visibility, local, created_at, updated_at)
         VALUES (?1, ?2, ?2, ?3, ?4, 'public', 1, ?5, ?5)`,
      ).bind(
        ids.remoteWrapper,
        `${BASE}/statuses/${ids.remoteWrapper}`,
        viewer.accountId,
        ids.remoteOriginal,
        now,
      ),
    ]);
  });

  async function fetchStatus(id: string): Promise<Response> {
    return SELF.fetch(`${BASE}/api/v1/statuses/${id}`, {
      headers: authHeaders(viewer.token),
    });
  }

  async function exactSearch(id: string): Promise<SearchEntity> {
    const response = await SELF.fetch(
      `${BASE}/api/v2/search?q=${encodeURIComponent(`${BASE}/statuses/${id}`)}&type=statuses`,
      { headers: authHeaders(viewer.token) },
    );
    expect(response.status).toBe(200);
    return response.json<SearchEntity>();
  }

  it('fills a surfaceable original for canonical fetch and exact URL search', async () => {
    const response = await fetchStatus(ids.wrapper);
    expect(response.status).toBe(200);
    expect((await response.json<StatusEntity>()).reblog?.id).toBe(ids.original);

    const search = await exactSearch(ids.wrapper);
    expect(search.statuses).toHaveLength(1);
    expect(search.statuses[0]?.reblog?.id).toBe(ids.original);
  });

  it('keeps viewer-side mute and block out of wrappers but not direct canonical originals', async () => {
    const now = new Date().toISOString();
    await env.DB_META_C000.prepare(
      `INSERT INTO mutes
        (id, account_id, target_account_id, hide_notifications, created_at, updated_at)
       VALUES ('canonical-boost-mute', ?1, ?2, 1, ?3, ?3)`,
    ).bind(viewer.accountId, originalAuthor.accountId, now).run();

    expect((await fetchStatus(ids.original)).status).toBe(200);
    expect((await fetchStatus(ids.wrapper)).status).toBe(404);
    expect((await exactSearch(ids.wrapper)).statuses).toEqual([]);
    await env.DB_META_C000.prepare("DELETE FROM mutes WHERE id = 'canonical-boost-mute'").run();

    await env.DB_META_C000.prepare(
      `INSERT INTO blocks (id, account_id, target_account_id, created_at)
       VALUES ('canonical-boost-viewer-block', ?1, ?2, ?3)`,
    ).bind(viewer.accountId, originalAuthor.accountId, now).run();

    expect((await fetchStatus(ids.original)).status).toBe(200);
    expect((await fetchStatus(ids.wrapper)).status).toBe(404);
    expect((await exactSearch(ids.wrapper)).statuses).toEqual([]);
    await env.DB_META_C000.prepare("DELETE FROM blocks WHERE id = 'canonical-boost-viewer-block'").run();
  });

  it('applies the author-to-viewer block to both canonical originals and wrappers', async () => {
    const now = new Date().toISOString();
    await env.DB_META_C000.prepare(
      `INSERT INTO blocks (id, account_id, target_account_id, created_at)
       VALUES ('canonical-boost-author-block', ?1, ?2, ?3)`,
    ).bind(originalAuthor.accountId, viewer.accountId, now).run();

    expect((await fetchStatus(ids.original)).status).toBe(404);
    expect((await fetchStatus(ids.wrapper)).status).toBe(404);
    expect((await exactSearch(ids.wrapper)).statuses).toEqual([]);
    await env.DB_META_C000.prepare("DELETE FROM blocks WHERE id = 'canonical-boost-author-block'").run();
  });

  it('returns no wrapper when the original is deleted or its author is suspended', async () => {
    const now = new Date().toISOString();
    await env.DB_META_C000.prepare(
      'UPDATE statuses SET deleted_at = ?1 WHERE id = ?2',
    ).bind(now, ids.original).run();
    expect((await fetchStatus(ids.wrapper)).status).toBe(404);
    expect((await exactSearch(ids.wrapper)).statuses).toEqual([]);
    await env.DB_META_C000.prepare(
      'UPDATE statuses SET deleted_at = NULL WHERE id = ?1',
    ).bind(ids.original).run();

    await env.DB_META_C000.prepare(
      'UPDATE accounts SET suspended_at = ?1 WHERE id = ?2',
    ).bind(now, originalAuthor.accountId).run();
    expect((await fetchStatus(ids.wrapper)).status).toBe(404);
    expect((await exactSearch(ids.wrapper)).statuses).toEqual([]);
    await env.DB_META_C000.prepare(
      'UPDATE accounts SET suspended_at = NULL WHERE id = ?1',
    ).bind(originalAuthor.accountId).run();
  });

  it('keeps a user-domain block out of wrappers but not direct canonical originals', async () => {
    const anonymousResponse = await SELF.fetch(
      `${BASE}/api/v1/statuses/${ids.remoteWrapper}`,
    );
    expect(anonymousResponse.status).toBe(200);
    expect((await anonymousResponse.json<StatusEntity>()).reblog?.id).toBe(ids.remoteOriginal);

    await env.DB_META_C000.prepare(
      `INSERT INTO user_domain_blocks (id, account_id, domain, created_at)
       VALUES ('canonical-boost-domain-block', ?1, 'BLOCKED.EXAMPLE', ?2)`,
    ).bind(viewer.accountId, new Date().toISOString()).run();

    expect((await fetchStatus(ids.remoteOriginal)).status).toBe(200);
    expect((await fetchStatus(ids.remoteWrapper)).status).toBe(404);
    expect((await exactSearch(ids.remoteWrapper)).statuses).toEqual([]);
  });
});
