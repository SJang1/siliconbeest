import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  applyAccountCollectionPrivacyMigration,
  applyMigrationsBeforeAccountCollectionPrivacy,
} from './helpers';

type CollectionPrivacyRow = {
  id: string;
  hide_collections: number;
};

describe('account collection privacy migration', () => {
  it('keeps local accounts public and fails closed for every existing remote actor', async () => {
    await applyMigrationsBeforeAccountCollectionPrivacy();
    const now = new Date().toISOString();
    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare(
        `INSERT INTO accounts (id, username, domain, uri, created_at, updated_at)
         VALUES (?1, ?2, NULL, ?3, ?4, ?4)`,
      ).bind('local', 'local', 'https://local.example/users/local', now),
      env.DB_META_C000.prepare(
        `INSERT INTO accounts (
           id, username, domain, uri, followers_url, following_url,
           created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
      ).bind(
        'remote-with-urls',
        'remote-with-urls',
        'remote.example',
        'https://remote.example/users/with-urls',
        'https://remote.example/users/with-urls/followers',
        'https://remote.example/users/with-urls/following',
        now,
      ),
      env.DB_META_C000.prepare(
        `INSERT INTO accounts (id, username, domain, uri, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
      ).bind(
        'remote-without-urls',
        'remote-without-urls',
        'private.example',
        'https://private.example/users/without-urls',
        now,
      ),
    ]);

    await applyAccountCollectionPrivacyMigration();

    const { results } = await env.DB_META_C000.prepare(
      `SELECT id, hide_collections
       FROM accounts
       WHERE id IN (?1, ?2, ?3)
       ORDER BY id`,
    ).bind(
      'local',
      'remote-with-urls',
      'remote-without-urls',
    ).all<CollectionPrivacyRow>();

    expect(results).toEqual([
      { id: 'local', hide_collections: 0 },
      { id: 'remote-with-urls', hide_collections: 1 },
      { id: 'remote-without-urls', hide_collections: 1 },
    ]);
  });
});
