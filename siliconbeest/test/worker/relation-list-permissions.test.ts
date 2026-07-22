import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
type StatusPayload = { id: string };

describe('stored status relation list permissions', () => {
  let author: TestUser;
  let viewer: TestUser;

  beforeAll(async () => {
    await applyMigration();
    author = await createTestUser('relationlistauthor');
    viewer = await createTestUser('relationlistviewer');
  });

  it('hides stale favourites and bookmarks after private access is revoked', async () => {
    const followResponse = await SELF.fetch(`${BASE}/api/v1/accounts/${author.accountId}/follow`, {
      method: 'POST',
      headers: authHeaders(viewer.token),
    });
    expect(followResponse.status).toBe(200);

    const createResponse = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(author.token),
      body: JSON.stringify({ status: 'private stored relation', visibility: 'private' }),
    });
    expect(createResponse.status).toBe(200);
    const status = await createResponse.json<StatusPayload>();

    for (const action of ['favourite', 'bookmark'] as const) {
      const response = await SELF.fetch(`${BASE}/api/v1/statuses/${status.id}/${action}`, {
        method: 'POST',
        headers: authHeaders(viewer.token),
      });
      expect(response.status).toBe(200);
    }

    const unfollowResponse = await SELF.fetch(`${BASE}/api/v1/accounts/${author.accountId}/unfollow`, {
      method: 'POST',
      headers: authHeaders(viewer.token),
    });
    expect(unfollowResponse.status).toBe(200);

    for (const endpoint of ['favourites', 'bookmarks'] as const) {
      const response = await SELF.fetch(`${BASE}/api/v1/${endpoint}`, {
        headers: authHeaders(viewer.token),
      });
      expect(response.status).toBe(200);
      const statuses = await response.json<StatusPayload[]>();
      expect(statuses.some((item) => item.id === status.id)).toBe(false);
    }

    const favourite = await env.DB_META_C000.prepare(
      'SELECT id FROM favourites WHERE account_id = ?1 AND status_id = ?2',
    ).bind(viewer.accountId, status.id).first<{ id: string }>();
    const bookmark = await env.DB_META_C000.prepare(
      'SELECT id FROM bookmarks WHERE account_id = ?1 AND status_id = ?2',
    ).bind(viewer.accountId, status.id).first<{ id: string }>();
    expect(favourite).not.toBeNull();
    expect(bookmark).not.toBeNull();
  });
});
