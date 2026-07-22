import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

type StatusEntity = {
  id: string;
  pinned: boolean;
};

describe('profile pinned status permissions', () => {
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let other: Awaited<ReturnType<typeof createTestUser>>;

  const ids = {
    public: 'profile-pin-public',
    private: 'profile-pin-private',
    direct: 'profile-pin-direct',
    original: 'profile-pin-original',
    reblog: 'profile-pin-reblog',
  } as const;

  beforeAll(async () => {
    await applyMigration();
    owner = await createTestUser('profilepinowner');
    other = await createTestUser('profilepinother');
    const now = new Date().toISOString();

    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare(
        `INSERT INTO statuses
          (id, uri, account_id, visibility, local, pinned, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'public', 1, 1, ?4, ?4)`,
      ).bind(ids.public, `${BASE}/statuses/${ids.public}`, owner.accountId, now),
      env.DB_META_C000.prepare(
        `INSERT INTO statuses
          (id, uri, account_id, visibility, local, pinned, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'private', 1, 1, ?4, ?4)`,
      ).bind(ids.private, `${BASE}/statuses/${ids.private}`, owner.accountId, now),
      env.DB_META_C000.prepare(
        `INSERT INTO statuses
          (id, uri, account_id, visibility, local, pinned, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'direct', 1, 1, ?4, ?4)`,
      ).bind(ids.direct, `${BASE}/statuses/${ids.direct}`, owner.accountId, now),
      env.DB_META_C000.prepare(
        `INSERT INTO statuses
          (id, uri, account_id, visibility, local, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'public', 1, ?4, ?4)`,
      ).bind(ids.original, `${BASE}/statuses/${ids.original}`, other.accountId, now),
      env.DB_META_C000.prepare(
        `INSERT INTO statuses
          (id, uri, account_id, reblog_of_id, visibility, local, pinned, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'public', 1, 1, ?5, ?5)`,
      ).bind(
        ids.reblog,
        `${BASE}/statuses/${ids.reblog}`,
        owner.accountId,
        ids.original,
        now,
      ),
    ]);
  });

  it('returns actual pinned originals while excluding invalid direct and reblog pins', async () => {
    const response = await SELF.fetch(
      `${BASE}/api/v1/accounts/${owner.accountId}/statuses?pinned=true`,
      { headers: authHeaders(owner.token) },
    );
    expect(response.status).toBe(200);

    const statuses = await response.json<StatusEntity[]>();
    expect(statuses.map((status) => status.id).sort()).toEqual([
      ids.private,
      ids.public,
    ]);
    expect(statuses.every((status) => status.pinned)).toBe(true);
  });

  it('keeps profile visibility rules for pinned statuses', async () => {
    const response = await SELF.fetch(
      `${BASE}/api/v1/accounts/${owner.accountId}/statuses?pinned=true`,
    );
    expect(response.status).toBe(200);
    const statuses = await response.json<StatusEntity[]>();
    expect(statuses.map((status) => status.id)).toEqual([ids.public]);
    expect(statuses[0]?.pinned).toBe(true);
  });

  it('serializes the stored pin state on canonical status reads', async () => {
    const response = await SELF.fetch(`${BASE}/api/v1/statuses/${ids.public}`, {
      headers: authHeaders(owner.token),
    });
    expect(response.status).toBe(200);
    expect((await response.json<StatusEntity>()).pinned).toBe(true);
  });
});
