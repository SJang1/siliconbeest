import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

type TestUser = Awaited<ReturnType<typeof createTestUser>>;
type StatusResponse = { id: string };
type TimelineStatus = {
  id: string;
  reblog: { id: string; content: string } | null;
};
type SearchPayload = { statuses: Array<{ id: string }> };

async function createStatus(
  user: TestUser,
  text: string,
  visibility: 'public' | 'unlisted' | 'private' | 'direct',
): Promise<StatusResponse> {
  const response = await SELF.fetch(`${BASE}/api/v1/statuses`, {
    method: 'POST',
    headers: authHeaders(user.token),
    body: JSON.stringify({ status: text, visibility }),
  });
  expect(response.status).toBe(200);
  return response.json<StatusResponse>();
}

async function timelineIds(path: string, user: TestUser): Promise<string[]> {
  const response = await SELF.fetch(`${BASE}${path}`, {
    headers: authHeaders(user.token),
  });
  expect(response.status).toBe(200);
  const statuses = await response.json<Array<{ id: string }>>();
  return statuses.map((status) => status.id);
}

describe('timeline permission revalidation', () => {
  let author: TestUser;
  let viewer: TestUser;

  beforeAll(async () => {
    await applyMigration();
    author = await createTestUser('timelinepermissionauthor');
    viewer = await createTestUser('timelinepermissionviewer');
  });

  it('includes only valid direct mentions in the derived home timeline', async () => {
    const direct = await createStatus(author, 'direct without a recipient', 'direct');

    const invalidId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO statuses
         (id, uri, account_id, text, content, visibility, local, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4, ?5, 1, ?6, ?6)`,
    ).bind(
      invalidId,
      `${BASE}/users/timelinepermissionauthor/statuses/${invalidId}`,
      author.accountId,
      'invalid visibility must remain hidden',
      'friends',
      now,
    ).run();
    const hiddenIds = await timelineIds('/api/v1/timelines/home', viewer);
    expect(hiddenIds).not.toContain(direct.id);
    expect(hiddenIds).not.toContain(invalidId);

    await env.DB.prepare(
      `INSERT INTO mentions (id, status_id, account_id, created_at)
       VALUES (?1, ?2, ?3, ?4)`,
    ).bind(crypto.randomUUID(), direct.id, viewer.accountId, now).run();

    const mentionedIds = await timelineIds('/api/v1/timelines/home', viewer);
    expect(mentionedIds).toContain(direct.id);
    expect(mentionedIds).not.toContain(invalidId);
  });

  it('does not let list membership bypass private visibility', async () => {
    const publicStatus = await createStatus(author, 'public list status', 'public');
    const privateStatus = await createStatus(author, 'private list status', 'private');
    const listId = crypto.randomUUID();
    const now = new Date().toISOString();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO lists (id, account_id, title, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)`,
      ).bind(listId, viewer.accountId, 'Permission test list', now),
      env.DB.prepare(
        'INSERT INTO list_accounts (list_id, account_id) VALUES (?1, ?2)',
      ).bind(listId, author.accountId),
    ]);

    const hiddenIds = await timelineIds(`/api/v1/timelines/list/${listId}`, viewer);
    expect(hiddenIds).toContain(publicStatus.id);
    expect(hiddenIds).not.toContain(privateStatus.id);

    const followResponse = await SELF.fetch(`${BASE}/api/v1/accounts/${author.accountId}/follow`, {
      method: 'POST',
      headers: authHeaders(viewer.token),
    });
    expect(followResponse.status).toBe(200);

    const followerIds = await timelineIds(`/api/v1/timelines/list/${listId}`, viewer);
    expect(followerIds).toContain(privateStatus.id);

    const unfollowResponse = await SELF.fetch(`${BASE}/api/v1/accounts/${author.accountId}/unfollow`, {
      method: 'POST',
      headers: authHeaders(viewer.token),
    });
    expect(unfollowResponse.status).toBe(200);
  });

  it('does not serialize a hidden original through a public reblog wrapper', async () => {
    const privateOriginal = await createStatus(author, 'hidden reblog original', 'private');
    const publicWrapper = await createStatus(viewer, 'public wrapper row', 'public');
    await env.DB.prepare(
      'UPDATE statuses SET reblog_of_id = ?1 WHERE id = ?2',
    ).bind(privateOriginal.id, publicWrapper.id).run();

    const viewerResponse = await SELF.fetch(`${BASE}/api/v1/timelines/public`, {
      headers: authHeaders(viewer.token),
    });
    expect(viewerResponse.status).toBe(200);
    const viewerStatuses = await viewerResponse.json<TimelineStatus[]>();
    expect(viewerStatuses.map((status) => status.id)).not.toContain(publicWrapper.id);

    const authorResponse = await SELF.fetch(`${BASE}/api/v1/timelines/public`, {
      headers: authHeaders(author.token),
    });
    expect(authorResponse.status).toBe(200);
    const authorStatuses = await authorResponse.json<TimelineStatus[]>();
    expect(authorStatuses.map((status) => status.id)).not.toContain(publicWrapper.id);
  });

  it('applies mute and either-direction block only to surfaced timelines', async () => {
    const relationshipAuthor = await createTestUser('timelinepermissionrelationauthor');
    const relationshipViewer = await createTestUser('timelinepermissionrelationviewer');
    const publicStatus = await createStatus(
      relationshipAuthor,
      'public relationship-filtered status',
      'public',
    );
    const publicWrapper = await createStatus(
      relationshipViewer,
      'public relationship-filtered wrapper',
      'public',
    );
    await env.DB.prepare(
      'UPDATE statuses SET reblog_of_id = ?1 WHERE id = ?2',
    ).bind(publicStatus.id, publicWrapper.id).run();

    const muteResponse = await SELF.fetch(
      `${BASE}/api/v1/accounts/${relationshipAuthor.accountId}/mute`,
      { method: 'POST', headers: authHeaders(relationshipViewer.token) },
    );
    expect(muteResponse.status).toBe(200);
    expect(await timelineIds('/api/v1/timelines/public', relationshipViewer)).not.toContain(
      publicStatus.id,
    );
    expect(await timelineIds('/api/v1/trends/statuses', relationshipViewer)).not.toContain(
      publicStatus.id,
    );
    expect(await timelineIds('/api/v1/timelines/public', relationshipViewer)).not.toContain(
      publicWrapper.id,
    );
    expect(await timelineIds('/api/v1/timelines/home', relationshipViewer)).not.toContain(
      publicWrapper.id,
    );
    expect(await timelineIds('/api/v1/timelines/social', relationshipViewer)).not.toContain(
      publicWrapper.id,
    );
    expect(await timelineIds(
      `/api/v1/accounts/${relationshipViewer.accountId}/statuses`,
      relationshipViewer,
    )).not.toContain(publicWrapper.id);

    const directWhileMuted = await SELF.fetch(`${BASE}/api/v1/statuses/${publicStatus.id}`, {
      headers: authHeaders(relationshipViewer.token),
    });
    expect(directWhileMuted.status).toBe(200);

    const unmuteResponse = await SELF.fetch(
      `${BASE}/api/v1/accounts/${relationshipAuthor.accountId}/unmute`,
      { method: 'POST', headers: authHeaders(relationshipViewer.token) },
    );
    expect(unmuteResponse.status).toBe(200);
    const unmutedTimeline = await SELF.fetch(`${BASE}/api/v1/timelines/public`, {
      headers: authHeaders(relationshipViewer.token),
    });
    const unmutedWrapper = (await unmutedTimeline.json<TimelineStatus[]>())
      .find((status) => status.id === publicWrapper.id);
    expect(unmutedWrapper?.reblog?.id).toBe(publicStatus.id);
    expect(await timelineIds('/api/v1/timelines/home', relationshipViewer)).toContain(
      publicWrapper.id,
    );
    expect(await timelineIds('/api/v1/timelines/social', relationshipViewer)).toContain(
      publicWrapper.id,
    );
    expect(await timelineIds(
      `/api/v1/accounts/${relationshipViewer.accountId}/statuses`,
      relationshipViewer,
    )).toContain(publicWrapper.id);

    const blockResponse = await SELF.fetch(
      `${BASE}/api/v1/accounts/${relationshipViewer.accountId}/block`,
      { method: 'POST', headers: authHeaders(relationshipAuthor.token) },
    );
    expect(blockResponse.status).toBe(200);
    expect(await timelineIds('/api/v1/timelines/public', relationshipViewer)).not.toContain(
      publicStatus.id,
    );
    expect(await timelineIds('/api/v1/trends/statuses', relationshipViewer)).not.toContain(
      publicStatus.id,
    );
    expect(await timelineIds('/api/v1/timelines/public', relationshipViewer)).not.toContain(
      publicWrapper.id,
    );
    expect(await timelineIds('/api/v1/timelines/home', relationshipViewer)).not.toContain(
      publicWrapper.id,
    );
    expect(await timelineIds('/api/v1/timelines/social', relationshipViewer)).not.toContain(
      publicWrapper.id,
    );
    expect(await timelineIds(
      `/api/v1/accounts/${relationshipViewer.accountId}/statuses`,
      relationshipViewer,
    )).not.toContain(publicWrapper.id);

    const directWhileBlocked = await SELF.fetch(`${BASE}/api/v1/statuses/${publicStatus.id}`, {
      headers: authHeaders(relationshipViewer.token),
    });
    expect(directWhileBlocked.status).toBe(404);
  });

  it('fails closed for suspended authors and limits silenced authors to followers', async () => {
    const stateAuthor = await createTestUser('timelinepermissionstateauthor');
    const stateViewer = await createTestUser('timelinepermissionstateviewer');
    const suspendedStatus = await createStatus(
      stateAuthor,
      'suspended author permission marker',
      'public',
    );
    const now = new Date().toISOString();
    await env.DB.prepare(
      'UPDATE accounts SET suspended_at = ?1 WHERE id = ?2',
    ).bind(now, stateAuthor.accountId).run();

    expect(await timelineIds('/api/v1/timelines/public', stateViewer)).not.toContain(
      suspendedStatus.id,
    );
    expect(await timelineIds('/api/v1/trends/statuses', stateViewer)).not.toContain(
      suspendedStatus.id,
    );
    const suspendedFetch = await SELF.fetch(`${BASE}/api/v1/statuses/${suspendedStatus.id}`, {
      headers: authHeaders(stateViewer.token),
    });
    expect(suspendedFetch.status).toBe(404);

    await env.DB.prepare(
      'UPDATE accounts SET suspended_at = NULL, silenced_at = ?1 WHERE id = ?2',
    ).bind(now, stateAuthor.accountId).run();
    const silencedStatus = await createStatus(
      stateAuthor,
      'silenced author permission marker',
      'public',
    );
    const storedSilencedStatus = await env.DB.prepare(
      'SELECT visibility FROM statuses WHERE id = ?1',
    ).bind(silencedStatus.id).first<{ visibility: string }>();
    expect(storedSilencedStatus?.visibility).toBe('unlisted');

    expect(await timelineIds('/api/v1/timelines/public', stateViewer)).not.toContain(
      silencedStatus.id,
    );
    expect(await timelineIds('/api/v1/trends/statuses', stateViewer)).not.toContain(
      silencedStatus.id,
    );
    expect(await timelineIds(`/api/v1/accounts/${stateAuthor.accountId}/statuses`, stateViewer)).not.toContain(
      silencedStatus.id,
    );
    const directFetch = await SELF.fetch(`${BASE}/api/v1/statuses/${silencedStatus.id}`, {
      headers: authHeaders(stateViewer.token),
    });
    expect(directFetch.status).toBe(200);

    const hiddenSearch = await SELF.fetch(
      `${BASE}/api/v2/search?q=silenced%20author%20permission%20marker&type=statuses`,
      { headers: authHeaders(stateViewer.token) },
    );
    expect(hiddenSearch.status).toBe(200);
    expect((await hiddenSearch.json<SearchPayload>()).statuses).toHaveLength(0);

    const followResponse = await SELF.fetch(`${BASE}/api/v1/accounts/${stateAuthor.accountId}/follow`, {
      method: 'POST',
      headers: authHeaders(stateViewer.token),
    });
    expect(followResponse.status).toBe(200);
    expect(await timelineIds('/api/v1/timelines/public', stateViewer)).not.toContain(
      silencedStatus.id,
    );
    expect(await timelineIds('/api/v1/trends/statuses', stateViewer)).not.toContain(
      silencedStatus.id,
    );
    expect(await timelineIds(`/api/v1/accounts/${stateAuthor.accountId}/statuses`, stateViewer)).toContain(
      silencedStatus.id,
    );
    expect(await timelineIds('/api/v1/timelines/home', stateViewer)).toContain(
      silencedStatus.id,
    );

    const followerSearch = await SELF.fetch(
      `${BASE}/api/v2/search?q=silenced%20author%20permission%20marker&type=statuses`,
      { headers: authHeaders(stateViewer.token) },
    );
    expect(followerSearch.status).toBe(200);
    expect((await followerSearch.json<SearchPayload>()).statuses.map((status) => status.id)).toContain(
      silencedStatus.id,
    );
  });
});
