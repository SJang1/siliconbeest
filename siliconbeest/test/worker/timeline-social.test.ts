import { SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('GET /api/v1/timelines/social', () => {
  let viewer: { accountId: string; userId: string; token: string };
  let poster: { accountId: string; userId: string; token: string };

  async function post(token: string, status: string, visibility: string): Promise<{ id: string }> {
    const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ status, visibility }),
    });
    expect(res.status).toBe(200);
    return res.json();
  }

  beforeAll(async () => {
    await applyMigration();
    viewer = await createTestUser('socialviewer');
    poster = await createTestUser('socialposter');
  });

  it('requires authentication', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/timelines/social`);
    expect(res.status).toBe(401);
  });

  it('derives followed private statuses without persisted home entries', async () => {
    // Local public post by someone the viewer does NOT follow → local branch
    const localPublic = await post(poster.token, 'hello social timeline', 'public');

    const homePrivate = await post(poster.token, 'private but in home', 'private');
    const hiddenPrivate = await post(poster.token, 'private and hidden', 'private');

    const res = await SELF.fetch(`${BASE}/api/v1/timelines/social`, {
      headers: authHeaders(viewer.token),
    });
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { id: string }[]).map((s) => s.id);

    expect(ids).toContain(localPublic.id);
    expect(ids).not.toContain(homePrivate.id);
    expect(ids).not.toContain(hiddenPrivate.id);

    const followRes = await SELF.fetch(`${BASE}/api/v1/accounts/${poster.accountId}/follow`, {
      method: 'POST',
      headers: authHeaders(viewer.token),
    });
    expect(followRes.status).toBe(200);

    const followedRes = await SELF.fetch(`${BASE}/api/v1/timelines/social`, {
      headers: authHeaders(viewer.token),
    });
    expect(followedRes.status).toBe(200);
    const followedIds = ((await followedRes.json()) as { id: string }[]).map((s) => s.id);
    expect(followedIds).toContain(homePrivate.id);
    expect(followedIds).toContain(hiddenPrivate.id);

    const unfollowRes = await SELF.fetch(`${BASE}/api/v1/accounts/${poster.accountId}/unfollow`, {
      method: 'POST',
      headers: authHeaders(viewer.token),
    });
    expect(unfollowRes.status).toBe(200);

    const revokedRes = await SELF.fetch(`${BASE}/api/v1/timelines/social`, {
      headers: authHeaders(viewer.token),
    });
    expect(revokedRes.status).toBe(200);
    const revokedIds = ((await revokedRes.json()) as { id: string }[]).map((s) => s.id);
    expect(revokedIds).not.toContain(homePrivate.id);
    expect(revokedIds).not.toContain(hiddenPrivate.id);
  });

  it('paginates with max_id', async () => {
    const a = await post(poster.token, 'social page one', 'public');
    const res = await SELF.fetch(`${BASE}/api/v1/timelines/social?max_id=${a.id}`, {
      headers: authHeaders(viewer.token),
    });
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { id: string }[]).map((s) => s.id);
    expect(ids).not.toContain(a.id);
    for (const id of ids) {
      expect(id < a.id).toBe(true);
    }
  });
});
