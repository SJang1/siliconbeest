import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

type ContextEntity = {
  ancestors: Array<{ id: string }>;
  descendants: Array<{ id: string }>;
};

describe('status context surface permissions', () => {
  let viewer: Awaited<ReturnType<typeof createTestUser>>;
  let rootAuthor: Awaited<ReturnType<typeof createTestUser>>;
  let hiddenAuthor: Awaited<ReturnType<typeof createTestUser>>;
  let leafAuthor: Awaited<ReturnType<typeof createTestUser>>;

  const ids = {
    root: 'context-surface-root',
    hidden: 'context-surface-hidden-middle',
    leaf: 'context-surface-visible-leaf',
  } as const;

  beforeAll(async () => {
    await applyMigration();
    viewer = await createTestUser('context_surface_viewer');
    rootAuthor = await createTestUser('context_surface_root_author');
    hiddenAuthor = await createTestUser('context_surface_hidden_author');
    leafAuthor = await createTestUser('context_surface_leaf_author');
    const now = new Date().toISOString();

    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare(
        `INSERT INTO statuses
          (id, uri, account_id, content, visibility, local, created_at, updated_at)
         VALUES (?1, ?2, ?3, '<p>root</p>', 'public', 1, ?4, ?4)`,
      ).bind(ids.root, `${BASE}/statuses/${ids.root}`, rootAuthor.accountId, now),
      env.DB_META_C000.prepare(
        `INSERT INTO statuses
          (id, uri, account_id, in_reply_to_id, in_reply_to_account_id,
           content, visibility, local, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, '<p>hidden middle</p>', 'public', 1, ?6, ?6)`,
      ).bind(
        ids.hidden,
        `${BASE}/statuses/${ids.hidden}`,
        hiddenAuthor.accountId,
        ids.root,
        rootAuthor.accountId,
        now,
      ),
      env.DB_META_C000.prepare(
        `INSERT INTO statuses
          (id, uri, account_id, in_reply_to_id, in_reply_to_account_id,
           content, visibility, local, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, '<p>visible leaf</p>', 'public', 1, ?6, ?6)`,
      ).bind(
        ids.leaf,
        `${BASE}/statuses/${ids.leaf}`,
        leafAuthor.accountId,
        ids.hidden,
        hiddenAuthor.accountId,
        now,
      ),
      env.DB_META_C000.prepare(
        `INSERT INTO mutes
          (id, account_id, target_account_id, hide_notifications, created_at, updated_at)
         VALUES ('context-surface-mute', ?1, ?2, 1, ?3, ?3)`,
      ).bind(viewer.accountId, hiddenAuthor.accountId, now),
    ]);
  });

  it('omits a muted descendant while continuing through it to visible descendants', async () => {
    const response = await SELF.fetch(
      `${BASE}/api/v1/statuses/${ids.root}/context`,
      { headers: authHeaders(viewer.token) },
    );
    expect(response.status).toBe(200);
    const context = await response.json<ContextEntity>();
    expect(context.descendants.map((status) => status.id)).toEqual([ids.leaf]);
  });

  it('omits a muted ancestor while continuing through it to visible ancestors', async () => {
    const response = await SELF.fetch(
      `${BASE}/api/v1/statuses/${ids.leaf}/context`,
      { headers: authHeaders(viewer.token) },
    );
    expect(response.status).toBe(200);
    const context = await response.json<ContextEntity>();
    expect(context.ancestors.map((status) => status.id)).toEqual([ids.root]);
  });

  it('keeps the complete public chain for viewers without exclusions', async () => {
    const response = await SELF.fetch(
      `${BASE}/api/v1/statuses/${ids.root}/context`,
    );
    expect(response.status).toBe(200);
    const context = await response.json<ContextEntity>();
    expect(context.descendants.map((status) => status.id)).toEqual([
      ids.hidden,
      ids.leaf,
    ]);
  });
});
