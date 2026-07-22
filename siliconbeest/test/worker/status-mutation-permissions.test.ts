import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  deleteStatus,
  reblogStatus,
  unreblogStatus,
  votePoll,
} from '../../server/worker/services/status';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

interface TestUser {
  accountId: string;
  userId: string;
  token: string;
}

interface StatusOptions {
  local?: number;
  reblogOfId?: string | null;
  visibility?: string;
  content?: string;
}

async function insertStatus(
  id: string,
  accountId: string,
  options: StatusOptions = {},
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB_META_C000.prepare(
    `INSERT INTO statuses
       (id, uri, url, account_id, reblog_of_id, text, content, visibility,
        local, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
  ).bind(
    id,
    `${BASE}/statuses/${id}`,
    `${BASE}/@mutation/${id}`,
    accountId,
    options.reblogOfId ?? null,
    options.reblogOfId ? '' : `source-${id}`,
    options.content ?? (options.reblogOfId ? '' : `<p>${id}</p>`),
    options.visibility ?? 'public',
    options.local ?? 1,
    now,
  ).run();
}

async function countRows(
  table: 'poll_votes' | 'statuses',
  predicate: string,
  binding: string,
): Promise<number> {
  const row = await env.DB_META_C000.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate} = ?1`,
  ).bind(binding).first<{ count: number }>();
  return row?.count ?? 0;
}

describe('status mutation permission boundaries', () => {
  let author: TestUser;
  let other: TestUser;

  beforeAll(async () => {
    await applyMigration();
    author = await createTestUser('mutation_author');
    other = await createTestUser('mutation_other');
  });

  it('does not let an owned reblog wrapper become an editable Note', async () => {
    const originalId = 'mutation_edit_original';
    const wrapperId = 'mutation_edit_wrapper';
    await insertStatus(originalId, other.accountId);
    await insertStatus(wrapperId, author.accountId, { reblogOfId: originalId });

    const edit = await SELF.fetch(`${BASE}/api/v1/statuses/${wrapperId}`, {
      method: 'PUT',
      headers: authHeaders(author.token),
      body: JSON.stringify({ status: 'turn this boost into a Note' }),
    });
    expect(edit.status).toBe(422);

    const wrapper = await env.DB_META_C000.prepare(
      'SELECT reblog_of_id, text, content FROM statuses WHERE id = ?1',
    ).bind(wrapperId).first<{
      reblog_of_id: string | null;
      text: string;
      content: string;
    }>();
    expect(wrapper).toEqual({
      reblog_of_id: originalId,
      text: '',
      content: '',
    });

    const source = await SELF.fetch(`${BASE}/api/v1/statuses/${wrapperId}/source`, {
      headers: authHeaders(author.token),
    });
    expect(source.status).toBe(404);
  });

  it('pins only an owned local original with non-direct visibility', async () => {
    const publicId = 'mutation_pin_public';
    const directId = 'mutation_pin_direct';
    const remoteId = 'mutation_pin_remote';
    const originalId = 'mutation_pin_original';
    const wrapperId = 'mutation_pin_wrapper';
    await insertStatus(publicId, author.accountId);
    await insertStatus(directId, author.accountId, { visibility: 'direct' });
    await insertStatus(remoteId, author.accountId, { local: 0 });
    await insertStatus(originalId, other.accountId);
    await insertStatus(wrapperId, author.accountId, { reblogOfId: originalId });

    const validPin = await SELF.fetch(`${BASE}/api/v1/statuses/${publicId}/pin`, {
      method: 'POST',
      headers: authHeaders(author.token),
    });
    expect(validPin.status).toBe(200);

    for (const statusId of [directId, remoteId, wrapperId]) {
      const response = await SELF.fetch(`${BASE}/api/v1/statuses/${statusId}/pin`, {
        method: 'POST',
        headers: authHeaders(author.token),
      });
      expect(response.status).toBe(422);
    }

    const pinned = await env.DB_META_C000.prepare(
      `SELECT id, pinned FROM statuses
       WHERE id IN (?1, ?2, ?3, ?4)
       ORDER BY id`,
    ).bind(publicId, directId, remoteId, wrapperId).all<{ id: string; pinned: number }>();
    expect(Object.fromEntries(pinned.results.map((row) => [row.id, row.pinned]))).toEqual({
      [directId]: 0,
      [publicId]: 1,
      [remoteId]: 0,
      [wrapperId]: 0,
    });
  });

  it('rejects source and edits for a non-local status even if ownership is corrupt', async () => {
    const remoteId = 'mutation_remote_owned';
    await insertStatus(remoteId, author.accountId, { local: 0 });

    const source = await SELF.fetch(`${BASE}/api/v1/statuses/${remoteId}/source`, {
      headers: authHeaders(author.token),
    });
    expect(source.status).toBe(404);

    const edit = await SELF.fetch(`${BASE}/api/v1/statuses/${remoteId}`, {
      method: 'PUT',
      headers: authHeaders(author.token),
      body: JSON.stringify({ status: 'must not mutate a remote object' }),
    });
    expect(edit.status).toBe(422);
  });

  it('does not move media from another status through an edit', async () => {
    const firstId = 'mutation_media_first';
    const secondId = 'mutation_media_second';
    const mediaId = 'mutation_bound_media';
    const now = new Date().toISOString();
    await insertStatus(firstId, author.accountId);
    await insertStatus(secondId, author.accountId);
    await env.DB_META_C000.prepare(
      `INSERT INTO media_attachments
         (id, status_id, account_id, file_key, file_content_type, file_size,
          type, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'image/png', 1, 'image', ?5, ?5)`,
    ).bind(mediaId, firstId, author.accountId, `${author.accountId}/${mediaId}.png`, now).run();

    const edit = await SELF.fetch(`${BASE}/api/v1/statuses/${secondId}`, {
      method: 'PUT',
      headers: authHeaders(author.token),
      body: JSON.stringify({
        status: 'must not steal even my own attached media',
        media_ids: [mediaId],
      }),
    });
    expect(edit.status).toBe(422);

    const media = await env.DB_META_C000.prepare(
      'SELECT status_id FROM media_attachments WHERE id = ?1',
    ).bind(mediaId).first<{ status_id: string | null }>();
    expect(media?.status_id).toBe(firstId);
  });

  it('does not move attached media into a newly created status', async () => {
    const firstId = 'mutation_create_media_first';
    const mediaId = 'mutation_create_bound_media';
    const now = new Date().toISOString();
    await insertStatus(firstId, author.accountId);
    await env.DB_META_C000.prepare(
      `INSERT INTO media_attachments
         (id, status_id, account_id, file_key, file_content_type, file_size,
          type, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'image/png', 1, 'image', ?5, ?5)`,
    ).bind(mediaId, firstId, author.accountId, `${author.accountId}/${mediaId}.png`, now).run();

    const before = await countRows('statuses', 'account_id', author.accountId);
    const create = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(author.token),
      body: JSON.stringify({ status: '', media_ids: [mediaId] }),
    });
    expect(create.status).toBe(422);
    expect(await countRows('statuses', 'account_id', author.accountId)).toBe(before);

    const media = await env.DB_META_C000.prepare(
      'SELECT status_id FROM media_attachments WHERE id = ?1',
    ).bind(mediaId).first<{ status_id: string | null }>();
    expect(media?.status_id).toBe(firstId);
  });

  it('fails closed for explicit missing reply and quote targets', async () => {
    const before = await countRows('statuses', 'account_id', author.accountId);
    for (const reference of [
      { in_reply_to_id: 'mutation_missing_reply' },
      { quote_id: 'mutation_missing_quote' },
    ]) {
      const create = await SELF.fetch(`${BASE}/api/v1/statuses`, {
        method: 'POST',
        headers: authHeaders(author.token),
        body: JSON.stringify({ status: 'must not drop explicit intent', ...reference }),
      });
      expect(create.status).toBe(404);
    }
    expect(await countRows('statuses', 'account_id', author.accountId)).toBe(before);
  });

  it('clamps limited-account public posts and rejects moved-account creation', async () => {
    const limited = await createTestUser('mutation_limited');
    const moved = await createTestUser('mutation_moved');
    await env.DB_META_C000.prepare(
      'UPDATE accounts SET silenced_at = ?1 WHERE id = ?2',
    ).bind(new Date().toISOString(), limited.accountId).run();
    await env.DB_META_C000.prepare(
      'UPDATE accounts SET moved_to_account_id = ?1 WHERE id = ?2',
    ).bind(other.accountId, moved.accountId).run();

    const limitedCreate = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(limited.token),
      body: JSON.stringify({ status: 'limited post', visibility: 'public' }),
    });
    expect(limitedCreate.status).toBe(200);
    const limitedBody = await limitedCreate.json<{ id: string; visibility: string }>();
    expect(limitedBody.visibility).toBe('unlisted');
    const limitedStatus = await env.DB_META_C000.prepare(
      'SELECT visibility FROM statuses WHERE id = ?1',
    ).bind(limitedBody.id).first<{ visibility: string }>();
    expect(limitedStatus?.visibility).toBe('unlisted');

    const movedBefore = await countRows('statuses', 'account_id', moved.accountId);
    const movedCreate = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(moved.token),
      body: JSON.stringify({ status: 'must not be created' }),
    });
    expect(movedCreate.status).toBe(403);
    expect(await countRows('statuses', 'account_id', moved.accountId)).toBe(movedBefore);
  });

  it('fails closed when reblogStatus receives a missing target', async () => {
    const missingId = 'mutation_missing_reblog_target';
    await expect(reblogStatus(
      'test.siliconbeest.local',
      author.accountId,
      'mutation_author',
      missingId,
    )).rejects.toMatchObject({ statusCode: 404 });

    expect(await countRows('statuses', 'reblog_of_id', missingId)).toBe(0);
  });

  it('creates one reblog and increments counts once under concurrent calls', async () => {
    const originalId = 'mutation_concurrent_reblog_target';
    await insertStatus(originalId, other.accountId);

    const results = await Promise.all([
      reblogStatus(
        'test.siliconbeest.local',
        author.accountId,
        'mutation_author',
        originalId,
      ),
      reblogStatus(
        'test.siliconbeest.local',
        author.accountId,
        'mutation_author',
        originalId,
      ),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await countRows('statuses', 'reblog_of_id', originalId)).toBe(1);

    const original = await env.DB_META_C000.prepare(
      'SELECT reblogs_count FROM statuses WHERE id = ?1',
    ).bind(originalId).first<{ reblogs_count: number }>();
    expect(original?.reblogs_count).toBe(1);
  });

  it('revalidates parent visibility inside votePoll', async () => {
    const statusId = 'mutation_private_poll_status';
    const pollId = 'mutation_private_poll';
    const now = new Date().toISOString();
    await insertStatus(statusId, author.accountId, { visibility: 'private' });
    await env.DB_META_C000.prepare(
      `INSERT INTO polls
         (id, status_id, expires_at, multiple, votes_count, voters_count, options, created_at)
       VALUES (?1, ?2, ?3, 0, 0, 0, ?4, ?5)`,
    ).bind(
      pollId,
      statusId,
      new Date(Date.now() + 86_400_000).toISOString(),
      JSON.stringify([
        { title: 'Yes', votes_count: 0 },
        { title: 'No', votes_count: 0 },
      ]),
      now,
    ).run();

    await expect(votePoll(other.accountId, pollId, [0]))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(await countRows('poll_votes', 'poll_id', pollId)).toBe(0);
  });

  it('decrements counts only for the status row actually deleted', async () => {
    const originalId = 'mutation_delete_original';
    const wrapperId = 'mutation_delete_wrapper';
    await insertStatus(originalId, other.accountId);
    await insertStatus(wrapperId, author.accountId, { reblogOfId: originalId });
    await env.DB_META_C000.prepare(
      'UPDATE statuses SET reblogs_count = 1 WHERE id = ?1',
    ).bind(originalId).run();
    await env.DB_META_C000.prepare(
      'UPDATE accounts SET statuses_count = statuses_count + 1 WHERE id = ?1',
    ).bind(author.accountId).run();

    const before = await env.DB_META_C000.prepare(
      'SELECT statuses_count FROM accounts WHERE id = ?1',
    ).bind(author.accountId).first<{ statuses_count: number }>();

    const deleted = await deleteStatus(wrapperId, author.accountId);
    expect(deleted.status.id).toBe(wrapperId);
    await expect(deleteStatus(wrapperId, author.accountId))
      .rejects.toMatchObject({ statusCode: 404 });

    const original = await env.DB_META_C000.prepare(
      'SELECT reblogs_count FROM statuses WHERE id = ?1',
    ).bind(originalId).first<{ reblogs_count: number }>();
    const after = await env.DB_META_C000.prepare(
      'SELECT statuses_count FROM accounts WHERE id = ?1',
    ).bind(author.accountId).first<{ statuses_count: number }>();
    expect(original?.reblogs_count).toBe(0);
    expect(after?.statuses_count).toBe((before?.statuses_count ?? 0) - 1);
  });

  it('makes concurrent unreblog cleanup decrement counts once', async () => {
    const originalId = 'mutation_unreblog_original';
    const wrapperId = 'mutation_unreblog_wrapper';
    await insertStatus(originalId, other.accountId);
    await insertStatus(wrapperId, author.accountId, { reblogOfId: originalId });
    await env.DB_META_C000.prepare(
      'UPDATE statuses SET reblogs_count = 1 WHERE id = ?1',
    ).bind(originalId).run();

    const results = await Promise.all([
      unreblogStatus(author.accountId, originalId),
      unreblogStatus(author.accountId, originalId),
    ]);
    expect(results.filter((result) => result.reblogId !== null)).toHaveLength(1);

    const original = await env.DB_META_C000.prepare(
      'SELECT reblogs_count FROM statuses WHERE id = ?1',
    ).bind(originalId).first<{ reblogs_count: number }>();
    expect(original?.reblogs_count).toBe(0);
  });
});
