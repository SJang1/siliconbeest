import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigration, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('ActivityStreams Article support', () => {
  let accountId: string;

  beforeAll(async () => {
    await applyMigration();
    const user = await createTestUser('articleauthor');
    accountId = user.accountId;
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
});
