import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('ActivityStreams Article support', () => {
  let accountId: string;
  let token: string;

  beforeAll(async () => {
    await applyMigration();
    const user = await createTestUser('articleauthor');
    accountId = user.accountId;
    token = user.token;
  });

  it('serializes a stored local Article with its title and body', async () => {
    const id = '01ARTICLE000000000000000001';
    const uri = `${BASE}/users/articleauthor/statuses/${id}`;
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO statuses
       (id, uri, url, object_type, title, account_id, text, content,
        visibility, local, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Article', ?4, ?5, ?6, ?7, 'public', 1, ?8, ?8)`,
    ).bind(
      id,
      uri,
      `${BASE}/@articleauthor/${id}`,
      'Federated long-form writing',
      accountId,
      'A long article body',
      '<p>A long article body</p>',
      now,
    ).run();

    const response = await SELF.fetch(uri, {
      headers: { Accept: 'application/activity+json' },
    });
    expect(response.status).toBe(200);
    const article = await response.json<Record<string, unknown>>();
    expect(article.type).toBe('Article');
    expect(article.name).toBe('Federated long-form writing');
    expect(article.content).toBe('<p>A long article body</p>');
    expect(article.attributedTo).toBe(`${BASE}/users/articleauthor`);
  });

  it('creates, reads, edits, and federates a long-form Article', async () => {
    const body = 'Long-form body. '.repeat(80);
    expect(body.length).toBeGreaterThan(500);

    const createResponse = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        object_type: 'Article',
        title: 'My first federated article',
        status: body,
        visibility: 'public',
      }),
    });
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json<Record<string, any>>();
    expect(created.object_type).toBe('Article');
    expect(created.title).toBe('My first federated article');
    expect(created.content).toContain('Long-form body.');

    const stored = await env.DB.prepare(
      'SELECT object_type, title, text FROM statuses WHERE id = ?1',
    ).bind(created.id).first<{ object_type: string; title: string; text: string }>();
    expect(stored).toMatchObject({
      object_type: 'Article',
      title: 'My first federated article',
      text: body.trim(),
    });

    const articleResponse = await SELF.fetch(created.uri, {
      headers: { Accept: 'application/activity+json' },
    });
    expect(articleResponse.status).toBe(200);
    const article = await articleResponse.json<Record<string, unknown>>();
    expect(article.type).toBe('Article');
    expect(article.name).toBe('My first federated article');

    const searchResponse = await SELF.fetch(
      `${BASE}/api/v2/search?q=${encodeURIComponent('first federated article')}&type=statuses`,
      { headers: authHeaders(token) },
    );
    expect(searchResponse.status).toBe(200);
    const search = await searchResponse.json<Record<string, any>>();
    expect(search.statuses.some((status: Record<string, unknown>) => status.id === created.id)).toBe(true);

    const editResponse = await SELF.fetch(`${BASE}/api/v1/statuses/${created.id}`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify({
        object_type: 'Article',
        title: 'An edited federated article',
        status: `${body}\n\nEdited ending.`,
      }),
    });
    expect(editResponse.status).toBe(200);
    const edited = await editResponse.json<Record<string, any>>();
    expect(edited.object_type).toBe('Article');
    expect(edited.title).toBe('An edited federated article');
    expect(edited.edited_at).toBeTruthy();

    const historyResponse = await SELF.fetch(`${BASE}/api/v1/statuses/${created.id}/history`, {
      headers: authHeaders(token),
    });
    expect(historyResponse.status).toBe(200);
    const history = await historyResponse.json<Array<Record<string, unknown>>>();
    expect(history[0]).toMatchObject({
      object_type: 'Article',
      title: 'My first federated article',
    });
    expect(history.at(-1)).toMatchObject({
      object_type: 'Article',
      title: 'An edited federated article',
    });
  });

  it('rejects an Article without a title', async () => {
    const response = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ object_type: 'Article', status: 'Untitled body' }),
    });
    expect(response.status).toBe(422);
  });
});
