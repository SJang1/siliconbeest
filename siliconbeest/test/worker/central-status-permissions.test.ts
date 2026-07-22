import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildReblogOriginalSurfaceSqlPredicate,
  buildStatusVisibilitySqlPredicate,
  buildStatusRelationshipSqlPredicate,
  buildNotificationRelationshipSqlPredicate,
  canAccountInteractWithStatus,
  canSurfaceStatusToViewer,
  canViewStatusById,
  assertStatusesViewableForAccount,
} from '../../server/worker/services/permissions';
import type { StatusPermissionSqlSource } from '../../server/worker/services/permissions';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('central status permissions', () => {
  let author: Awaited<ReturnType<typeof createTestUser>>;
  let follower: Awaited<ReturnType<typeof createTestUser>>;
  let mentioned: Awaited<ReturnType<typeof createTestUser>>;
  let stranger: Awaited<ReturnType<typeof createTestUser>>;
  let suspendedAuthor: Awaited<ReturnType<typeof createTestUser>>;
  let silencedAuthor: Awaited<ReturnType<typeof createTestUser>>;

  beforeAll(async () => {
    await applyMigration();
    author = await createTestUser('central-author');
    follower = await createTestUser('central-follower');
    mentioned = await createTestUser('central-mentioned');
    stranger = await createTestUser('central-stranger');
    suspendedAuthor = await createTestUser('central-suspended');
    silencedAuthor = await createTestUser('central-silenced');

    const now = new Date().toISOString();
    await env.DB_META_C000.prepare(
      `INSERT INTO follows (id, account_id, target_account_id, created_at, updated_at)
       VALUES ('central-follow', ?1, ?2, ?3, ?3)`,
    ).bind(follower.accountId, author.accountId, now).run();
    await env.DB_META_C000.prepare(
      `INSERT INTO follows (id, account_id, target_account_id, created_at, updated_at)
       VALUES ('central-silenced-follow', ?1, ?2, ?3, ?3)`,
    ).bind(follower.accountId, silencedAuthor.accountId, now).run();

    const insertStatus = env.DB_META_C000.prepare(
      `INSERT INTO statuses (
         id, uri, url, account_id, text, content, visibility, sensitive,
         language, local, created_at, updated_at, deleted_at
       ) VALUES (?1, ?2, ?2, ?3, ?4, ?4, ?5, 0, 'en', 1, ?6, ?6, ?7)`,
    );
    await env.DB_META_C000.batch([
      insertStatus.bind('central-public', 'https://local.test/status/public', author.accountId, 'public', 'public', now, null),
      insertStatus.bind('central-unlisted', 'https://local.test/status/unlisted', author.accountId, 'unlisted', 'unlisted', now, null),
      insertStatus.bind('central-private', 'https://local.test/status/private', author.accountId, 'private', 'private', now, null),
      insertStatus.bind('central-direct-one', 'https://local.test/status/direct-one', author.accountId, 'direct one', 'direct', now, null),
      insertStatus.bind('central-direct-two', 'https://local.test/status/direct-two', author.accountId, 'direct two', 'direct', now, null),
      insertStatus.bind('central-invalid', 'https://local.test/status/invalid', author.accountId, 'invalid', 'followers', now, null),
      insertStatus.bind('central-deleted', 'https://local.test/status/deleted', author.accountId, 'deleted', 'public', now, now),
      insertStatus.bind('central-suspended-status', 'https://local.test/status/suspended', suspendedAuthor.accountId, 'suspended', 'public', now, null),
      insertStatus.bind('central-silenced-status', 'https://local.test/status/silenced', silencedAuthor.accountId, 'silenced', 'public', now, null),
    ]);
    await env.DB_META_C000.prepare(
      `INSERT INTO mentions (id, status_id, account_id, created_at)
       VALUES ('central-mention', 'central-direct-one', ?1, ?2),
              ('central-private-mention', 'central-private', ?1, ?2)`,
    ).bind(mentioned.accountId, now).run();
    await env.DB_META_C000.prepare(
      `INSERT INTO accounts (
         id, username, domain, uri, url, created_at, updated_at
       ) VALUES (
         'central-remote-author', 'remote', 'blocked.example',
         'https://blocked.example/users/remote',
         'https://blocked.example/@remote', ?1, ?1
       )`,
    ).bind(now).run();
    await env.DB_META_C000.prepare(
      `INSERT INTO statuses (
         id, uri, url, account_id, text, content, visibility, sensitive,
         language, local, created_at, updated_at, deleted_at
       ) VALUES (
         'central-remote-public', 'https://blocked.example/status/1',
         'https://blocked.example/status/1', 'central-remote-author',
         'remote', 'remote', 'public', 0, 'en', 0, ?1, ?1, NULL
       )`,
    ).bind(now).run();
    await env.DB_META_C000.prepare(
      'UPDATE accounts SET suspended_at = ?1 WHERE id = ?2',
    ).bind(now, suspendedAuthor.accountId).run();
    await env.DB_META_C000.prepare(
      'UPDATE accounts SET silenced_at = ?1 WHERE id = ?2',
    ).bind(now, silencedAuthor.accountId).run();
  });

  it('applies public, follower, and exact-status mention rules', async () => {
    expect(await canViewStatusById('central-public', null)).toBe(true);
    expect(await canViewStatusById('central-unlisted', null)).toBe(true);
    expect(await canViewStatusById('central-private', follower.accountId)).toBe(true);
    expect(await canViewStatusById('central-private', mentioned.accountId)).toBe(true);
    expect(await canViewStatusById('central-private', stranger.accountId)).toBe(false);
    expect(await canViewStatusById('central-direct-one', mentioned.accountId)).toBe(true);
    expect(await canViewStatusById('central-direct-two', mentioned.accountId)).toBe(false);
  });

  it('fails closed for invalid and deleted rows, including for their author', async () => {
    expect(await canViewStatusById('central-invalid', author.accountId)).toBe(false);
    expect(await canViewStatusById('central-deleted', author.accountId)).toBe(false);
    expect(await canViewStatusById('central-suspended-status', null)).toBe(false);
    expect(await canViewStatusById('central-suspended-status', suspendedAuthor.accountId)).toBe(false);
  });

  it('builds a list predicate with the same rules', async () => {
    const predicate = buildStatusVisibilitySqlPredicate('status', mentioned.accountId);
    const rows = await env.DB_META_C000.prepare(
      `SELECT s.id FROM statuses s
       WHERE s.account_id = ? AND ${predicate.sql}
       ORDER BY s.id`,
    ).bind(author.accountId, ...predicate.bindings).all<{ id: string }>();

    expect(rows.results.map((row) => row.id)).toEqual([
      'central-direct-one',
      'central-private',
      'central-public',
      'central-unlisted',
    ]);
    const maliciousSource = 's; DROP TABLE statuses' as StatusPermissionSqlSource;
    expect(() => buildStatusVisibilitySqlPredicate(maliciousSource, null)).toThrow('Invalid SQL source');

    const viewerLikeSql = "viewer' OR 1 = 1 --";
    const boundViewer = buildStatusVisibilitySqlPredicate('status', viewerLikeSql);
    expect(boundViewer.sql).not.toContain(viewerLikeSql);
    expect(boundViewer.bindings).toEqual([
      viewerLikeSql,
      viewerLikeSql,
      viewerLikeSql,
      viewerLikeSql,
    ]);
    const privateRow = await env.DB_META_C000.prepare(
      `SELECT s.id FROM statuses s
       WHERE s.id = 'central-private' AND ${boundViewer.sql}`,
    ).bind(...boundViewer.bindings).first<{ id: string }>();
    expect(privateRow).toBeNull();
  });

  it('keeps reblog-original aliases fixed and viewer identifiers bound', () => {
    const viewerId = "viewer' OR 1 = 1 --";
    const predicate = buildReblogOriginalSurfaceSqlPredicate(
      viewerId,
      '2026-07-15T00:00:00.000Z',
    );

    expect(predicate.sql).toContain('FROM statuses rs');
    expect(predicate.sql).toContain('s.reblog_of_id');
    expect(predicate.sql).not.toContain(viewerId);
    expect(predicate.bindings.filter((value) => value === viewerId)).toHaveLength(10);
  });

  it('hides public canonical resources only in the author-to-viewer block direction', async () => {
    const now = new Date().toISOString();
    await env.DB_META_C000.prepare(
      `INSERT INTO blocks (id, account_id, target_account_id, created_at)
       VALUES ('central-author-blocks-viewer', ?1, ?2, ?3)`,
    ).bind(author.accountId, stranger.accountId, now).run();

    expect(await canViewStatusById('central-public', null)).toBe(true);
    expect(await canViewStatusById('central-public', stranger.accountId)).toBe(false);
    expect((await SELF.fetch(`${BASE}/api/v1/statuses/central-public`, {
      headers: authHeaders(stranger.token),
    })).status).toBe(404);

    await env.DB_META_C000.prepare("DELETE FROM blocks WHERE id = 'central-author-blocks-viewer'").run();
    await env.DB_META_C000.prepare(
      `INSERT INTO blocks (id, account_id, target_account_id, created_at)
       VALUES ('central-viewer-blocks-author', ?1, ?2, ?3)`,
    ).bind(stranger.accountId, author.accountId, now).run();

    expect(await canViewStatusById('central-public', stranger.accountId)).toBe(true);
    expect(await canAccountInteractWithStatus('central-public', stranger.accountId)).toBe(false);

    await env.DB_META_C000.prepare("DELETE FROM blocks WHERE id = 'central-viewer-blocks-author'").run();
  });

  it('surfaces silenced authors only to themselves and followers', async () => {
    const isSurfaced = async (viewerAccountId: string | null) => {
      const predicate = buildStatusRelationshipSqlPredicate(
        'status',
        viewerAccountId,
        new Date().toISOString(),
      );
      const row = await env.DB_META_C000.prepare(
        `SELECT s.id FROM statuses s
         WHERE s.id = 'central-silenced-status' AND ${predicate.sql}`,
      ).bind(...predicate.bindings).first<{ id: string }>();
      return row !== null;
    };

    await expect(isSurfaced(null)).resolves.toBe(false);
    await expect(isSurfaced(stranger.accountId)).resolves.toBe(false);
    await expect(isSurfaced(follower.accountId)).resolves.toBe(true);
    await expect(isSurfaced(silencedAuthor.accountId)).resolves.toBe(true);
  });

  it('revalidates exact visibility and relationship suppression for a surface recipient', async () => {
    expect(await canSurfaceStatusToViewer('central-direct-one', mentioned.accountId)).toBe(true);
    expect(await canSurfaceStatusToViewer('central-direct-two', mentioned.accountId)).toBe(false);
    expect(await canSurfaceStatusToViewer('central-direct-one', '')).toBe(false);

    await env.DB_META_C000.prepare(
      `INSERT INTO blocks (id, account_id, target_account_id, created_at)
       VALUES ('central-reverse-block', ?1, ?2, ?3)`,
    ).bind(author.accountId, mentioned.accountId, new Date().toISOString()).run();
    expect(await canSurfaceStatusToViewer('central-direct-one', mentioned.accountId)).toBe(false);
    await env.DB_META_C000.prepare("DELETE FROM blocks WHERE id = 'central-reverse-block'").run();
  });

  it('suppresses blocked remote domains on surfaces and interactions but not canonical fetches', async () => {
    expect(await canViewStatusById('central-remote-public', stranger.accountId)).toBe(true);
    expect(await canSurfaceStatusToViewer('central-remote-public', stranger.accountId)).toBe(true);

    await env.DB_META_C000.prepare(
      `INSERT INTO user_domain_blocks (id, account_id, domain, created_at)
       VALUES ('central-domain-block', ?1, 'BLOCKED.EXAMPLE', ?2)`,
    ).bind(stranger.accountId, new Date().toISOString()).run();

    expect(await canViewStatusById('central-remote-public', stranger.accountId)).toBe(true);
    expect(await canSurfaceStatusToViewer('central-remote-public', stranger.accountId)).toBe(false);
    expect(await canAccountInteractWithStatus('central-remote-public', stranger.accountId)).toBe(false);

    const notificationPermission = buildNotificationRelationshipSqlPredicate(
      'notification_sender',
      stranger.accountId,
      new Date().toISOString(),
    );
    const remoteSender = await env.DB_META_C000.prepare(
      `SELECT a.id FROM accounts a
       WHERE a.id = 'central-remote-author'
         AND ${notificationPermission.sql}`,
    ).bind(...notificationPermission.bindings).first<{ id: string }>();
    expect(remoteSender).toBeNull();

    await env.DB_META_C000.prepare(
      "DELETE FROM user_domain_blocks WHERE id = 'central-domain-block'",
    ).run();
  });

  it('filters stale notification reads by sender state, notification mutes, and blocks', async () => {
    const canReadNotification = async (recipientAccountId: string) => {
      const predicate = buildNotificationRelationshipSqlPredicate(
        'notification_sender',
        recipientAccountId,
        new Date().toISOString(),
      );
      const notificationSender = await env.DB_META_C000.prepare(
        `SELECT a.id FROM accounts a
         WHERE a.id = ? AND ${predicate.sql}`,
      ).bind(author.accountId, ...predicate.bindings).first<{ id: string }>();
      return notificationSender !== null;
    };

    await expect(canReadNotification(mentioned.accountId)).resolves.toBe(true);
    const now = new Date().toISOString();
    await env.DB_META_C000.prepare(
      `INSERT INTO mutes (
         id, account_id, target_account_id, hide_notifications, expires_at,
         created_at, updated_at
       ) VALUES ('central-notification-mute', ?1, ?2, 0, NULL, ?3, ?3)`,
    ).bind(mentioned.accountId, author.accountId, now).run();
    await expect(canReadNotification(mentioned.accountId)).resolves.toBe(true);
    await env.DB_META_C000.prepare(
      "UPDATE mutes SET hide_notifications = 1 WHERE id = 'central-notification-mute'",
    ).run();
    await expect(canReadNotification(mentioned.accountId)).resolves.toBe(false);
    await env.DB_META_C000.prepare("DELETE FROM mutes WHERE id = 'central-notification-mute'").run();

    await env.DB_META_C000.prepare(
      `INSERT INTO blocks (id, account_id, target_account_id, created_at)
       VALUES ('central-notification-block', ?1, ?2, ?3)`,
    ).bind(author.accountId, mentioned.accountId, now).run();
    await expect(canReadNotification(mentioned.accountId)).resolves.toBe(false);
    await env.DB_META_C000.prepare("DELETE FROM blocks WHERE id = 'central-notification-block'").run();

    const emptyRecipient = buildNotificationRelationshipSqlPredicate(
      'notification_sender',
      '',
      now,
    );
    const denied = await env.DB_META_C000.prepare(
      `SELECT a.id FROM accounts a
       WHERE a.id = ? AND ${emptyRecipient.sql}`,
    ).bind(author.accountId).first<{ id: string }>();
    expect(denied).toBeNull();
  });

  it('allows status interactions only for active actors with canonical visibility', async () => {
    expect(await canAccountInteractWithStatus('central-public', stranger.accountId)).toBe(true);
    expect(await canAccountInteractWithStatus('central-private', follower.accountId)).toBe(true);
    expect(await canAccountInteractWithStatus('central-private', stranger.accountId)).toBe(false);
    expect(await canAccountInteractWithStatus('central-direct-one', mentioned.accountId)).toBe(true);
    expect(await canAccountInteractWithStatus('central-public', suspendedAuthor.accountId)).toBe(false);
  });

  it('validates and de-duplicates report status references for the target account', async () => {
    await expect(assertStatusesViewableForAccount(
      ['central-public', 'central-public', 'central-private'],
      follower.accountId,
      author.accountId,
    )).resolves.toEqual(['central-public', 'central-private']);

    await expect(assertStatusesViewableForAccount(
      ['central-public'],
      follower.accountId,
      stranger.accountId,
    )).rejects.toMatchObject({ statusCode: 404 });
    await expect(assertStatusesViewableForAccount(
      ['central-invalid'],
      author.accountId,
      author.accountId,
    )).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects invalid visibility before creating a status', async () => {
    const response = await SELF.fetch(`${BASE}/api/v1/statuses`, {
      method: 'POST',
      headers: authHeaders(author.token),
      body: JSON.stringify({ status: 'must not persist', visibility: 'followers' }),
    });
    expect(response.status).toBe(422);

    const stored = await env.DB_META_C000.prepare(
      "SELECT id FROM statuses WHERE account_id = ?1 AND text = 'must not persist'",
    ).bind(author.accountId).first<{ id: string }>();
    expect(stored).toBeNull();
  });

  it('conceals an invalid stored status from fetch, context, and history', async () => {
    for (const path of [
      '/api/v1/statuses/central-invalid',
      '/api/v1/statuses/central-invalid/context',
      '/api/v1/statuses/central-invalid/history',
    ]) {
      const response = await SELF.fetch(`${BASE}${path}`, {
        headers: authHeaders(author.token),
      });
      expect(response.status).toBe(404);
    }
  });

  it('conceals statuses authored by a suspended account', async () => {
    const response = await SELF.fetch(`${BASE}/api/v1/statuses/central-suspended-status`);
    expect(response.status).toBe(404);
  });
});
