import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

interface TestUser {
  accountId: string;
  userId: string;
  token: string;
}

async function insertStatus(
  id: string,
  accountId: string,
  visibility: string,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO statuses
       (id, uri, url, account_id, text, content, visibility, local, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)`,
  ).bind(
    id,
    `${BASE}/statuses/${id}`,
    `${BASE}/@permissions/${id}`,
    accountId,
    `source-${id}`,
    `<p>${id}</p>`,
    visibility,
    now,
  ).run();
}

async function insertPoll(id: string, statusId: string): Promise<void> {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO polls
       (id, status_id, expires_at, multiple, votes_count, voters_count, options, created_at)
     VALUES (?1, ?2, ?3, 0, 0, 0, ?4, ?5)`,
  ).bind(
    id,
    statusId,
    expiresAt,
    JSON.stringify([
      { title: 'Yes', votes_count: 0 },
      { title: 'No', votes_count: 0 },
    ]),
    now,
  ).run();
}

async function countRows(
  table: 'bookmarks' | 'emoji_reactions' | 'favourites' | 'poll_votes' | 'status_mutes',
  accountId: string,
  foreignKey: 'poll_id' | 'status_id',
  resourceId: string,
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE account_id = ?1 AND ${foreignKey} = ?2`,
  ).bind(accountId, resourceId).first<{ count: number }>();
  return row?.count ?? 0;
}

describe('status-dependent API permissions', () => {
  let author: TestUser;
  let follower: TestUser;
  let mentioned: TestUser;
  let stranger: TestUser;
  let writeOnly: TestUser;

  const ids = {
    public: 'interaction_public',
    private: 'interaction_private',
    direct: 'interaction_direct',
    deleted: 'interaction_deleted',
    invalid: 'interaction_invalid',
    writeOnly: 'interaction_write_only',
    privatePoll: 'interaction_private_poll',
    directPoll: 'interaction_direct_poll',
    invalidPoll: 'interaction_invalid_poll',
    strangerReblog: 'interaction_stranger_reblog',
  };

  beforeAll(async () => {
    await applyMigration();
    author = await createTestUser('interaction_author');
    follower = await createTestUser('interaction_follower');
    mentioned = await createTestUser('interaction_mentioned');
    stranger = await createTestUser('interaction_stranger');
    writeOnly = await createTestUser('interaction_write_only');

    await insertStatus(ids.public, author.accountId, 'public');
    await insertStatus(ids.private, author.accountId, 'private');
    await insertStatus(ids.direct, author.accountId, 'direct');
    await insertStatus(ids.deleted, author.accountId, 'public');
    await insertStatus(ids.invalid, author.accountId, 'team-only');
    await insertStatus(ids.writeOnly, writeOnly.accountId, 'public');

    const now = new Date().toISOString();
    await env.DB.prepare(
      'UPDATE statuses SET deleted_at = ?1 WHERE id = ?2',
    ).bind(now, ids.deleted).run();
    await env.DB.prepare(
      `INSERT INTO follows (id, account_id, target_account_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)`,
    ).bind('interaction_follow', follower.accountId, author.accountId, now).run();
    await env.DB.prepare(
      `INSERT INTO mentions (id, status_id, account_id, created_at)
       VALUES (?1, ?2, ?3, ?4)`,
    ).bind('interaction_mention', ids.direct, mentioned.accountId, now).run();

    await insertPoll(ids.privatePoll, ids.private);
    await insertPoll(ids.directPoll, ids.direct);
    await insertPoll(ids.invalidPoll, ids.invalid);

    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO favourites (id, account_id, status_id, created_at) VALUES (?1, ?2, ?3, ?4)',
      ).bind('interaction_favourite', stranger.accountId, ids.private, now),
      env.DB.prepare(
        'INSERT INTO bookmarks (id, account_id, status_id, created_at) VALUES (?1, ?2, ?3, ?4)',
      ).bind('interaction_bookmark', stranger.accountId, ids.private, now),
      env.DB.prepare(
        'INSERT INTO status_mutes (id, account_id, status_id, created_at) VALUES (?1, ?2, ?3, ?4)',
      ).bind('interaction_mute', stranger.accountId, ids.private, now),
      env.DB.prepare(
        `INSERT INTO emoji_reactions (id, account_id, status_id, emoji, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      ).bind('interaction_reaction', stranger.accountId, ids.private, '👍', now),
      env.DB.prepare(
        `INSERT INTO statuses
           (id, uri, account_id, reblog_of_id, visibility, local, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'public', 1, ?5, ?5)`,
      ).bind(
        ids.strangerReblog,
        `${BASE}/statuses/${ids.strangerReblog}`,
        stranger.accountId,
        ids.private,
        now,
      ),
    ]);

    await env.DB.prepare(
      "UPDATE oauth_access_tokens SET scopes = 'write' WHERE user_id = ?1",
    ).bind(writeOnly.userId).run();
  });

  it('restricts source to the author with read:statuses scope', async () => {
    const authorResponse = await SELF.fetch(
      `${BASE}/api/v1/statuses/${ids.private}/source`,
      { headers: authHeaders(author.token) },
    );
    expect(authorResponse.status).toBe(200);

    const followerResponse = await SELF.fetch(
      `${BASE}/api/v1/statuses/${ids.private}/source`,
      { headers: authHeaders(follower.token) },
    );
    expect(followerResponse.status).toBe(404);

    const insufficientScope = await SELF.fetch(
      `${BASE}/api/v1/statuses/${ids.writeOnly}/source`,
      { headers: authHeaders(writeOnly.token) },
    );
    expect(insufficientScope.status).toBe(403);
  });

  it('denies hidden or invalid status mutations before adding relations', async () => {
    const cases = [
      { path: 'favourite', method: 'POST', table: 'favourites' as const },
      { path: 'bookmark', method: 'POST', table: 'bookmarks' as const },
      { path: 'mute', method: 'POST', table: 'status_mutes' as const },
    ];

    for (const testCase of cases) {
      const hiddenId = ids.direct;
      const response = await SELF.fetch(
        `${BASE}/api/v1/statuses/${hiddenId}/${testCase.path}`,
        { method: testCase.method, headers: authHeaders(stranger.token) },
      );
      expect(response.status).toBe(404);
      expect(await countRows(testCase.table, stranger.accountId, 'status_id', hiddenId)).toBe(0);

      const invalidResponse = await SELF.fetch(
        `${BASE}/api/v1/statuses/${ids.invalid}/${testCase.path}`,
        { method: testCase.method, headers: authHeaders(author.token) },
      );
      expect(invalidResponse.status).toBe(404);
    }

    const reactionResponse = await SELF.fetch(
      `${BASE}/api/v1/statuses/${ids.direct}/react/${encodeURIComponent('👍')}`,
      { method: 'PUT', headers: authHeaders(stranger.token) },
    );
    expect(reactionResponse.status).toBe(404);
    expect(await countRows('emoji_reactions', stranger.accountId, 'status_id', ids.direct)).toBe(0);
  });

  it('conceals hidden statuses before applying reblog validation', async () => {
    const strangerResponse = await SELF.fetch(
      `${BASE}/api/v1/statuses/${ids.private}/reblog`,
      { method: 'POST', headers: authHeaders(stranger.token) },
    );
    expect(strangerResponse.status).toBe(404);

    const followerResponse = await SELF.fetch(
      `${BASE}/api/v1/statuses/${ids.private}/reblog`,
      { method: 'POST', headers: authHeaders(follower.token) },
    );
    expect(followerResponse.status).toBe(422);

    const invalidResponse = await SELF.fetch(
      `${BASE}/api/v1/statuses/${ids.invalid}/reblog`,
      { method: 'POST', headers: authHeaders(author.token) },
    );
    expect(invalidResponse.status).toBe(404);
  });

  it('keeps a viewer-side block out of canonical fetches but rejects outbound interactions', async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO blocks (id, account_id, target_account_id, created_at)
       VALUES ('interaction-viewer-block', ?1, ?2, ?3)`,
    ).bind(stranger.accountId, author.accountId, now).run();

    expect((await SELF.fetch(`${BASE}/api/v1/statuses/${ids.public}`, {
      headers: authHeaders(stranger.token),
    })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/api/v1/statuses/${ids.public}/favourite`, {
      method: 'POST',
      headers: authHeaders(stranger.token),
    })).status).toBe(404);
    expect((await SELF.fetch(
      `${BASE}/api/v1/statuses/${ids.public}/react/${encodeURIComponent('👍')}`,
      { method: 'PUT', headers: authHeaders(stranger.token) },
    )).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/api/v1/statuses/${ids.public}/reblog`, {
      method: 'POST',
      headers: authHeaders(stranger.token),
    })).status).toBe(403);

    expect(await countRows('favourites', stranger.accountId, 'status_id', ids.public)).toBe(0);
    expect(await countRows('emoji_reactions', stranger.accountId, 'status_id', ids.public)).toBe(0);
    await env.DB.prepare("DELETE FROM blocks WHERE id = 'interaction-viewer-block'").run();
  });

  it('checks visibility before returning relationship and reaction lists', async () => {
    for (const path of ['favourited_by', 'reblogged_by']) {
      expect((await SELF.fetch(`${BASE}/api/v1/statuses/${ids.private}/${path}`)).status).toBe(401);
      expect((await SELF.fetch(
        `${BASE}/api/v1/statuses/${ids.private}/${path}`,
        { headers: authHeaders(stranger.token) },
      )).status).toBe(404);
      expect((await SELF.fetch(
        `${BASE}/api/v1/statuses/${ids.private}/${path}`,
        { headers: authHeaders(follower.token) },
      )).status).toBe(200);
      expect((await SELF.fetch(
        `${BASE}/api/v1/statuses/${ids.direct}/${path}`,
        { headers: authHeaders(stranger.token) },
      )).status).toBe(404);
      expect((await SELF.fetch(
        `${BASE}/api/v1/statuses/${ids.direct}/${path}`,
        { headers: authHeaders(mentioned.token) },
      )).status).toBe(200);
      expect((await SELF.fetch(
        `${BASE}/api/v1/statuses/${ids.deleted}/${path}`,
        { headers: authHeaders(author.token) },
      )).status).toBe(404);
      expect((await SELF.fetch(
        `${BASE}/api/v1/statuses/${ids.invalid}/${path}`,
        { headers: authHeaders(author.token) },
      )).status).toBe(404);
    }

    for (const path of ['reactions']) {
      expect((await SELF.fetch(`${BASE}/api/v1/statuses/${ids.private}/${path}`)).status).toBe(404);
      expect((await SELF.fetch(
        `${BASE}/api/v1/statuses/${ids.private}/${path}`,
        { headers: authHeaders(stranger.token) },
      )).status).toBe(404);
      expect((await SELF.fetch(
        `${BASE}/api/v1/statuses/${ids.private}/${path}`,
        { headers: authHeaders(follower.token) },
      )).status).toBe(200);
    }
  });

  it('cleans up the caller relation but returns no hidden status body', async () => {
    const removals = [
      { path: 'unfavourite', method: 'POST', table: 'favourites' as const },
      { path: 'unbookmark', method: 'POST', table: 'bookmarks' as const },
      { path: 'unmute', method: 'POST', table: 'status_mutes' as const },
      {
        path: `react/${encodeURIComponent('👍')}`,
        method: 'DELETE',
        table: 'emoji_reactions' as const,
      },
    ];

    for (const removal of removals) {
      const response = await SELF.fetch(
        `${BASE}/api/v1/statuses/${ids.private}/${removal.path}`,
        { method: removal.method, headers: authHeaders(stranger.token) },
      );
      expect(response.status).toBe(404);
      expect(await countRows(removal.table, stranger.accountId, 'status_id', ids.private)).toBe(0);
    }

    const unreblogResponse = await SELF.fetch(
      `${BASE}/api/v1/statuses/${ids.private}/unreblog`,
      { method: 'POST', headers: authHeaders(stranger.token) },
    );
    expect(unreblogResponse.status).toBe(404);
    const reblog = await env.DB.prepare(
      'SELECT deleted_at FROM statuses WHERE id = ?1',
    ).bind(ids.strangerReblog).first<{ deleted_at: string | null }>();
    expect(reblog?.deleted_at).not.toBeNull();
  });

  it('applies parent status visibility to poll reads and votes', async () => {
    expect((await SELF.fetch(`${BASE}/api/v1/polls/${ids.privatePoll}`)).status).toBe(404);
    expect((await SELF.fetch(
      `${BASE}/api/v1/polls/${ids.privatePoll}`,
      { headers: authHeaders(stranger.token) },
    )).status).toBe(404);
    expect((await SELF.fetch(
      `${BASE}/api/v1/polls/${ids.privatePoll}`,
      { headers: authHeaders(follower.token) },
    )).status).toBe(200);
    expect((await SELF.fetch(
      `${BASE}/api/v1/polls/${ids.directPoll}`,
      { headers: authHeaders(mentioned.token) },
    )).status).toBe(200);
    expect((await SELF.fetch(
      `${BASE}/api/v1/polls/${ids.invalidPoll}`,
      { headers: authHeaders(author.token) },
    )).status).toBe(404);

    const hiddenVote = await SELF.fetch(
      `${BASE}/api/v1/polls/${ids.privatePoll}/votes`,
      {
        method: 'POST',
        headers: authHeaders(stranger.token),
        body: JSON.stringify({ choices: [0] }),
      },
    );
    expect(hiddenVote.status).toBe(404);
    expect(await countRows(
      'poll_votes',
      stranger.accountId,
      'poll_id',
      ids.privatePoll,
    )).toBe(0);
  });
});
