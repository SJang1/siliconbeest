import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

type TestUser = {
  accountId: string;
  userId: string;
  token: string;
};

type NotificationResponse = {
  id: string;
  type: string;
  status: { id: string; content: string } | null;
};

async function insertNotification(
  id: string,
  recipientAccountId: string,
  senderAccountId: string,
  statusId: string | null = null,
): Promise<void> {
  await env.DB_META_C000.prepare(
    `INSERT INTO notifications (
       id, account_id, from_account_id, type, status_id, read, created_at
     ) VALUES (?1, ?2, ?3, 'mention', ?4, 0, ?5)`,
  ).bind(
    id,
    recipientAccountId,
    senderAccountId,
    statusId,
    new Date().toISOString(),
  ).run();
}

async function insertStatus(
  authorAccountId: string,
  visibility: 'public' | 'private' | 'direct',
  conversationId: string | null = null,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB_META_C000.prepare(
    `INSERT INTO statuses (
       id, uri, url, account_id, text, content, visibility, conversation_id,
       local, created_at, updated_at
     ) VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)`,
  ).bind(
    id,
    `https://test.siliconbeest.local/statuses/${id}`,
    authorAccountId,
    `${visibility} notification status`,
    `<p>${visibility} notification status</p>`,
    visibility,
    conversationId,
    now,
  ).run();
  return id;
}

describe('notification read permissions', () => {
  let recipient: TestUser;
  let sender: TestUser;
  let alternateSender: TestUser;

  beforeAll(async () => {
    await applyMigration();
    recipient = await createTestUser('notification-reader');
    sender = await createTestUser('notification-sender');
    alternateSender = await createTestUser('notification-alternate');
  });

  beforeEach(async () => {
    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare('DELETE FROM notifications WHERE account_id = ?1').bind(recipient.accountId),
      env.DB_META_C000.prepare('DELETE FROM status_mutes WHERE account_id = ?1').bind(recipient.accountId),
      env.DB_META_C000.prepare('DELETE FROM mutes WHERE account_id = ?1').bind(recipient.accountId),
      env.DB_META_C000.prepare(
        'DELETE FROM blocks WHERE account_id IN (?1, ?2, ?3) OR target_account_id IN (?1, ?2, ?3)',
      ).bind(recipient.accountId, sender.accountId, alternateSender.accountId),
      env.DB_META_C000.prepare('DELETE FROM follows WHERE account_id = ?1').bind(recipient.accountId),
      env.DB_META_C000.prepare('DELETE FROM mentions WHERE account_id = ?1').bind(recipient.accountId),
      env.DB_META_C000.prepare(
        'UPDATE accounts SET suspended_at = NULL, silenced_at = NULL WHERE id IN (?1, ?2)',
      ).bind(sender.accountId, alternateSender.accountId),
    ]);
  });

  async function listNotifications(limit?: number): Promise<NotificationResponse[]> {
    const suffix = limit === undefined ? '' : `?limit=${limit}`;
    const response = await SELF.fetch(`${BASE}/api/v1/notifications${suffix}`, {
      headers: authHeaders(recipient.token),
    });
    expect(response.status).toBe(200);
    return response.json<NotificationResponse[]>();
  }

  async function fetchNotification(id: string): Promise<Response> {
    return SELF.fetch(`${BASE}/api/v1/notifications/${id}`, {
      headers: authHeaders(recipient.token),
    });
  }

  it('honors hide_notifications and ignores disabled or expired notification mutes', async () => {
    const notificationId = 'notification-mute-policy';
    await insertNotification(notificationId, recipient.accountId, sender.accountId);
    const now = new Date().toISOString();
    await env.DB_META_C000.prepare(
      `INSERT INTO mutes (
         id, account_id, target_account_id, hide_notifications, expires_at,
         created_at, updated_at
       ) VALUES ('notification-read-mute', ?1, ?2, 0, NULL, ?3, ?3)`,
    ).bind(recipient.accountId, sender.accountId, now).run();

    expect((await listNotifications()).map((item) => item.id)).toContain(notificationId);
    expect((await fetchNotification(notificationId)).status).toBe(200);

    await env.DB_META_C000.prepare(
      "UPDATE mutes SET hide_notifications = 1 WHERE id = 'notification-read-mute'",
    ).run();
    expect((await listNotifications()).map((item) => item.id)).not.toContain(notificationId);
    expect((await fetchNotification(notificationId)).status).toBe(404);

    await env.DB_META_C000.prepare(
      "UPDATE mutes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = 'notification-read-mute'",
    ).run();
    expect((await listNotifications()).map((item) => item.id)).toContain(notificationId);
    expect((await fetchNotification(notificationId)).status).toBe(200);
  });

  it('uses notification mute semantics for both sender and a distinct status author', async () => {
    const statusId = await insertStatus(alternateSender.accountId, 'public');
    const notificationId = 'notification-distinct-status-author-mute';
    const now = new Date().toISOString();
    await insertNotification(notificationId, recipient.accountId, sender.accountId, statusId);
    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare(
        `INSERT INTO mutes (
           id, account_id, target_account_id, hide_notifications, expires_at,
           created_at, updated_at
         ) VALUES ('notification-sender-timeline-mute', ?1, ?2, 0, NULL, ?3, ?3)`,
      ).bind(recipient.accountId, sender.accountId, now),
      env.DB_META_C000.prepare(
        `INSERT INTO mutes (
           id, account_id, target_account_id, hide_notifications, expires_at,
           created_at, updated_at
         ) VALUES ('notification-author-timeline-mute', ?1, ?2, 0, NULL, ?3, ?3)`,
      ).bind(recipient.accountId, alternateSender.accountId, now),
    ]);

    expect((await listNotifications()).find((item) => item.id === notificationId)?.status?.id).toBe(statusId);
    expect((await fetchNotification(notificationId)).status).toBe(200);

    await env.DB_META_C000.prepare(
      "UPDATE mutes SET hide_notifications = 1 WHERE id = 'notification-author-timeline-mute'",
    ).run();
    expect((await listNotifications()).map((item) => item.id)).not.toContain(notificationId);
    expect((await fetchNotification(notificationId)).status).toBe(404);

    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare(
        "UPDATE mutes SET hide_notifications = 0 WHERE id = 'notification-author-timeline-mute'",
      ),
      env.DB_META_C000.prepare(
        "UPDATE mutes SET hide_notifications = 1 WHERE id = 'notification-sender-timeline-mute'",
      ),
    ]);
    expect((await listNotifications()).map((item) => item.id)).not.toContain(notificationId);
    expect((await fetchNotification(notificationId)).status).toBe(404);
  });

  it('filters recipient blocks, reverse blocks, and inactive senders', async () => {
    const notificationId = 'notification-sender-policy';
    await insertNotification(notificationId, recipient.accountId, sender.accountId);
    const now = new Date().toISOString();

    await env.DB_META_C000.prepare(
      `INSERT INTO blocks (id, account_id, target_account_id, created_at)
       VALUES ('notification-recipient-block', ?1, ?2, ?3)`,
    ).bind(recipient.accountId, sender.accountId, now).run();
    expect((await listNotifications()).map((item) => item.id)).not.toContain(notificationId);
    expect((await fetchNotification(notificationId)).status).toBe(404);
    await env.DB_META_C000.prepare("DELETE FROM blocks WHERE id = 'notification-recipient-block'").run();

    await env.DB_META_C000.prepare(
      `INSERT INTO blocks (id, account_id, target_account_id, created_at)
       VALUES ('notification-reverse-block', ?1, ?2, ?3)`,
    ).bind(sender.accountId, recipient.accountId, now).run();
    expect((await listNotifications()).map((item) => item.id)).not.toContain(notificationId);
    expect((await fetchNotification(notificationId)).status).toBe(404);
    await env.DB_META_C000.prepare("DELETE FROM blocks WHERE id = 'notification-reverse-block'").run();

    await env.DB_META_C000.prepare(
      'UPDATE accounts SET silenced_at = ?1 WHERE id = ?2',
    ).bind(now, sender.accountId).run();
    expect((await listNotifications()).map((item) => item.id)).not.toContain(notificationId);
    expect((await fetchNotification(notificationId)).status).toBe(404);

    await env.DB_META_C000.prepare(
      `INSERT INTO follows (id, account_id, target_account_id, created_at, updated_at)
       VALUES ('notification-silenced-sender-follow', ?1, ?2, ?3, ?3)`,
    ).bind(recipient.accountId, sender.accountId, now).run();
    expect((await listNotifications()).map((item) => item.id)).toContain(notificationId);
    expect((await fetchNotification(notificationId)).status).toBe(200);
    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare("DELETE FROM follows WHERE id = 'notification-silenced-sender-follow'"),
      env.DB_META_C000.prepare('UPDATE accounts SET silenced_at = NULL WHERE id = ?1').bind(sender.accountId),
    ]);

    await env.DB_META_C000.prepare(
      'UPDATE accounts SET suspended_at = ?1 WHERE id = ?2',
    ).bind(now, sender.accountId).run();
    expect((await listNotifications()).map((item) => item.id)).not.toContain(notificationId);
    expect((await fetchNotification(notificationId)).status).toBe(404);
  });

  it('revalidates state and bilateral blocks for a distinct status author', async () => {
    const statusId = await insertStatus(alternateSender.accountId, 'public');
    const notificationId = 'notification-distinct-status-author-state';
    const now = new Date().toISOString();
    await insertNotification(notificationId, recipient.accountId, sender.accountId, statusId);

    await env.DB_META_C000.prepare(
      'UPDATE accounts SET silenced_at = ?1 WHERE id = ?2',
    ).bind(now, alternateSender.accountId).run();
    expect((await listNotifications()).map((item) => item.id)).not.toContain(notificationId);
    expect((await fetchNotification(notificationId)).status).toBe(404);

    await env.DB_META_C000.prepare(
      `INSERT INTO follows (id, account_id, target_account_id, created_at, updated_at)
       VALUES ('notification-silenced-author-follow', ?1, ?2, ?3, ?3)`,
    ).bind(recipient.accountId, alternateSender.accountId, now).run();
    expect((await listNotifications()).map((item) => item.id)).toContain(notificationId);
    expect((await fetchNotification(notificationId)).status).toBe(200);
    await env.DB_META_C000.batch([
      env.DB_META_C000.prepare("DELETE FROM follows WHERE id = 'notification-silenced-author-follow'"),
      env.DB_META_C000.prepare('UPDATE accounts SET silenced_at = NULL WHERE id = ?1').bind(alternateSender.accountId),
    ]);

    await env.DB_META_C000.prepare(
      `INSERT INTO blocks (id, account_id, target_account_id, created_at)
       VALUES ('notification-recipient-status-author-block', ?1, ?2, ?3)`,
    ).bind(recipient.accountId, alternateSender.accountId, now).run();
    expect((await listNotifications()).map((item) => item.id)).not.toContain(notificationId);
    expect((await fetchNotification(notificationId)).status).toBe(404);
    await env.DB_META_C000.prepare("DELETE FROM blocks WHERE id = 'notification-recipient-status-author-block'").run();

    await env.DB_META_C000.prepare(
      `INSERT INTO blocks (id, account_id, target_account_id, created_at)
       VALUES ('notification-status-author-block', ?1, ?2, ?3)`,
    ).bind(alternateSender.accountId, recipient.accountId, now).run();
    expect((await listNotifications()).map((item) => item.id)).not.toContain(notificationId);
    expect((await fetchNotification(notificationId)).status).toBe(404);
    await env.DB_META_C000.prepare("DELETE FROM blocks WHERE id = 'notification-status-author-block'").run();

    await env.DB_META_C000.prepare(
      'UPDATE accounts SET suspended_at = ?1 WHERE id = ?2',
    ).bind(now, alternateSender.accountId).run();
    expect((await listNotifications()).map((item) => item.id)).not.toContain(notificationId);
    expect((await fetchNotification(notificationId)).status).toBe(404);
  });

  it('revokes private notification access after an unfollow', async () => {
    const statusId = await insertStatus(sender.accountId, 'private');
    const notificationId = 'notification-private-status';
    const now = new Date().toISOString();
    await env.DB_META_C000.prepare(
      `INSERT INTO follows (id, account_id, target_account_id, created_at, updated_at)
       VALUES ('notification-private-follow', ?1, ?2, ?3, ?3)`,
    ).bind(recipient.accountId, sender.accountId, now).run();
    await insertNotification(notificationId, recipient.accountId, sender.accountId, statusId);

    expect((await listNotifications()).find((item) => item.id === notificationId)?.status?.id).toBe(statusId);
    expect((await fetchNotification(notificationId)).status).toBe(200);

    await env.DB_META_C000.prepare("DELETE FROM follows WHERE id = 'notification-private-follow'").run();
    expect((await listNotifications()).map((item) => item.id)).not.toContain(notificationId);
    expect((await fetchNotification(notificationId)).status).toBe(404);
  });

  it('requires a mention on the exact direct status', async () => {
    const hiddenStatusId = await insertStatus(alternateSender.accountId, 'direct');
    const mentionedStatusId = await insertStatus(alternateSender.accountId, 'direct');
    const notificationId = 'notification-direct-status';
    await env.DB_META_C000.prepare(
      `INSERT INTO mentions (id, status_id, account_id, created_at)
       VALUES ('notification-other-mention', ?1, ?2, ?3)`,
    ).bind(mentionedStatusId, recipient.accountId, new Date().toISOString()).run();
    await insertNotification(notificationId, recipient.accountId, sender.accountId, hiddenStatusId);

    expect((await listNotifications()).map((item) => item.id)).not.toContain(notificationId);
    expect((await fetchNotification(notificationId)).status).toBe(404);

    await env.DB_META_C000.prepare(
      `INSERT INTO mentions (id, status_id, account_id, created_at)
       VALUES ('notification-exact-mention', ?1, ?2, ?3)`,
    ).bind(hiddenStatusId, recipient.accountId, new Date().toISOString()).run();
    expect((await listNotifications()).find((item) => item.id === notificationId)?.status?.id).toBe(hiddenStatusId);
    expect((await fetchNotification(notificationId)).status).toBe(200);
  });

  it('suppresses notifications muted by exact status or conversation thread', async () => {
    const conversationId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB_META_C000.prepare(
      'INSERT INTO conversations (id, created_at, updated_at) VALUES (?1, ?2, ?2)',
    ).bind(conversationId, now).run();
    const rootStatusId = await insertStatus(sender.accountId, 'public', conversationId);
    const replyStatusId = await insertStatus(sender.accountId, 'public', conversationId);
    const notificationId = 'notification-thread-muted';
    await insertNotification(notificationId, recipient.accountId, sender.accountId, replyStatusId);

    expect((await fetchNotification(notificationId)).status).toBe(200);
    await env.DB_META_C000.prepare(
      `INSERT INTO status_mutes (id, account_id, status_id, created_at)
       VALUES ('notification-thread-mute', ?1, ?2, ?3)`,
    ).bind(recipient.accountId, rootStatusId, now).run();
    expect((await listNotifications()).map((item) => item.id)).not.toContain(notificationId);
    expect((await fetchNotification(notificationId)).status).toBe(404);

    await env.DB_META_C000.prepare("DELETE FROM status_mutes WHERE id = 'notification-thread-mute'").run();
    await env.DB_META_C000.prepare(
      `INSERT INTO status_mutes (id, account_id, status_id, created_at)
       VALUES ('notification-exact-status-mute', ?1, ?2, ?3)`,
    ).bind(recipient.accountId, replyStatusId, now).run();
    expect((await listNotifications()).map((item) => item.id)).not.toContain(notificationId);
    expect((await fetchNotification(notificationId)).status).toBe(404);
  });

  it('applies permission filters before LIMIT', async () => {
    const now = new Date().toISOString();
    await insertNotification(
      'zzzz-notification-hidden',
      recipient.accountId,
      sender.accountId,
    );
    await insertNotification(
      'aaaa-notification-visible',
      recipient.accountId,
      alternateSender.accountId,
    );
    await env.DB_META_C000.prepare(
      `INSERT INTO blocks (id, account_id, target_account_id, created_at)
       VALUES ('notification-limit-block', ?1, ?2, ?3)`,
    ).bind(recipient.accountId, sender.accountId, now).run();

    const page = await listNotifications(1);
    expect(page.map((item) => item.id)).toEqual(['aaaa-notification-visible']);
  });
});
