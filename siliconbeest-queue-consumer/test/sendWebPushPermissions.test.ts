import { beforeEach, describe, expect, it, vi } from 'vitest';

interface NotificationPermissionRow {
  id: string;
  notification_type: string;
  status_id: string | null;
  notification_recipient_account_id: string;
  user_account_id: string | null;
  user_disabled: number | null;
  user_approved: number | null;
  recipient_suspended_at: string | null;
  recipient_memorial: number;
  sender_suspended_at: string | null;
  sender_memorial: number;
  sender_user_disabled: number | null;
  sender_user_approved: number | null;
  viewer_mutes_sender: number;
  viewer_blocks_sender: number;
  viewer_blocks_sender_domain: number;
  sender_blocks_viewer: number;
  status_account_id: string | null;
  status_visibility: string | null;
  status_deleted_at: string | null;
  status_author_suspended_at: string | null;
  status_author_silenced_at: string | null;
  viewer_follows_status_author: number;
  viewer_is_mentioned: number;
  viewer_mutes_status_author: number;
  viewer_blocks_status_author: number;
  viewer_blocks_status_author_domain: number;
  status_author_blocks_viewer: number;
  viewer_mutes_status_thread: number;
  sender_username: string;
  sender_domain: string | null;
  sender_display_name: string;
  status_username: string | null;
  status_domain: string | null;
}

const mocks = vi.hoisted(() => ({
  notificationRow: null as NotificationPermissionRow | null,
  queries: [] as string[],
  bindings: [] as (string | number)[][],
  env: {
    DB_META_C000: { prepare: vi.fn() },
    INSTANCE_DOMAIN: 'local.example',
  },
  base64urlDecode: vi.fn((value: string) => {
    const bytes = new Uint8Array(value === 'public-key' ? 65 : 32);
    if (bytes.length === 65) bytes[0] = 0x04;
    return bytes;
  }),
  sendPushNotification: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({ env: mocks.env }));
vi.mock('../src/shared/webpush', () => ({
  base64urlDecode: mocks.base64urlDecode,
  sendPushNotification: mocks.sendPushNotification,
}));

import { handleSendWebPush } from '../src/handlers/sendWebPush';

function queryAll(sql: string): Promise<{ results: object[] }> {
  if (sql.includes('FROM web_push_subscriptions')) {
    return Promise.resolve({
      results: [
        {
          id: 'subscription-1',
          endpoint: 'https://push.example/subscription-1',
          key_p256dh: 'p256dh',
          key_auth: 'auth',
        },
      ],
    });
  }
  if (sql.includes('FROM settings')) {
    return Promise.resolve({
      results: [
        { key: 'vapid_public_key', value: 'public-key' },
        { key: 'vapid_private_key', value: 'private-key' },
      ],
    });
  }
  throw new Error(`Unexpected all query: ${sql}`);
}

function configureDatabase(): void {
  mocks.env.DB_META_C000.prepare.mockImplementation((sql: string) => ({
    all: async () => {
      mocks.queries.push(sql);
      return queryAll(sql);
    },
    bind: (...params: (string | number)[]) => ({
      first: async () => {
        mocks.queries.push(sql);
        mocks.bindings.push(params);
        if (sql.includes('FROM notifications n')) return mocks.notificationRow;
        throw new Error(`Unexpected first query: ${sql} (${params.join(',')})`);
      },
      all: async () => {
        mocks.queries.push(sql);
        mocks.bindings.push(params);
        return queryAll(sql);
      },
      run: async () => ({ success: true }),
    }),
  }));
}

function validNotificationRow(): NotificationPermissionRow {
  return {
    id: 'notification-1',
    notification_type: 'mention',
    status_id: 'status-1',
    notification_recipient_account_id: 'recipient-account',
    user_account_id: 'recipient-account',
    user_disabled: 0,
    user_approved: 1,
    recipient_suspended_at: null,
    recipient_memorial: 0,
    sender_suspended_at: null,
    sender_memorial: 0,
    sender_user_disabled: 0,
    sender_user_approved: 1,
    viewer_mutes_sender: 0,
    viewer_blocks_sender: 0,
    viewer_blocks_sender_domain: 0,
    sender_blocks_viewer: 0,
    status_account_id: 'sender-account',
    status_visibility: 'public',
    status_deleted_at: null,
    status_author_suspended_at: null,
    status_author_silenced_at: null,
    viewer_follows_status_author: 0,
    viewer_is_mentioned: 0,
    viewer_mutes_status_author: 0,
    viewer_blocks_status_author: 0,
    viewer_blocks_status_author_domain: 0,
    status_author_blocks_viewer: 0,
    viewer_mutes_status_thread: 0,
    sender_username: 'sender',
    sender_domain: null,
    sender_display_name: 'Sender',
    status_username: 'recipient',
    status_domain: null,
  };
}

beforeEach(() => {
  mocks.notificationRow = null;
  mocks.queries.length = 0;
  mocks.bindings.length = 0;
  mocks.env.DB_META_C000.prepare.mockReset();
  mocks.base64urlDecode.mockClear();
  mocks.sendPushNotification.mockReset();
  mocks.sendPushNotification.mockResolvedValue({
    success: true,
    gone: false,
    status: 201,
  });
  configureDatabase();
});

describe('web push notification ownership', () => {
  it.each([
    [
      'another account owns the requested user',
      { user_account_id: 'another-account' },
    ],
    ['the requested user does not exist', { user_account_id: null }],
    ['the requested user is disabled', { user_disabled: 1 }],
    ['the requested user is unapproved', { user_approved: 0 }],
    [
      'the recipient account is suspended',
      { recipient_suspended_at: '2026-07-15T00:00:00.000Z' },
    ],
    ['the recipient account is memorialized', { recipient_memorial: 1 }],
  ] satisfies [string, Partial<NotificationPermissionRow>][])(
    'drops the push before loading subscriptions when %s',
    async (_label, overrides) => {
      mocks.notificationRow = { ...validNotificationRow(), ...overrides };

      await handleSendWebPush({
        type: 'send_web_push',
        notificationId: 'notification-1',
        userId: 'recipient-user',
      });

      expect(mocks.queries).toHaveLength(1);
      expect(mocks.queries[0]).toContain('FROM notifications n');
      expect(mocks.bindings[0]).toEqual([
        'recipient-user',
        'notification-1',
        expect.any(String),
      ]);
      expect(mocks.sendPushNotification).not.toHaveBeenCalled();
    },
  );

  it('delivers a notification only to its active recipient user', async () => {
    mocks.notificationRow = validNotificationRow();

    await handleSendWebPush({
      type: 'send_web_push',
      notificationId: 'notification-1',
      userId: 'recipient-user',
    });

    expect(
      mocks.queries.some((sql) =>
        sql.includes('FROM web_push_subscriptions')),
    ).toBe(true);
    expect(mocks.sendPushNotification).toHaveBeenCalledTimes(1);
    expect(mocks.sendPushNotification.mock.calls[0]?.[1]).toContain(
      'notification-1',
    );
  });

  it.each([
    [
      'the sender is suspended',
      { sender_suspended_at: '2026-07-15T00:00:00.000Z' },
    ],
    ['the sender is memorialized', { sender_memorial: 1 }],
    ['the local sender user is disabled', { sender_user_disabled: 1 }],
    ['the local sender user is unapproved', { sender_user_approved: 0 }],
    ['the recipient mutes sender notifications', { viewer_mutes_sender: 1 }],
    ['the recipient blocks the sender', { viewer_blocks_sender: 1 }],
    ['the recipient blocks the sender domain', {
      viewer_blocks_sender_domain: 1,
    }],
    ['the sender blocks the recipient', { sender_blocks_viewer: 1 }],
    ['the status no longer exists', { status_account_id: null }],
    ['the status is deleted', {
      status_deleted_at: '2026-07-15T00:00:00.000Z',
    }],
    ['the status is now private and unfollowed', { status_visibility: 'private' }],
    ['the status author is suspended', {
      status_author_suspended_at: '2026-07-15T00:00:00.000Z',
    }],
    ['the status author is silenced and unfollowed', {
      status_author_silenced_at: '2026-07-15T00:00:00.000Z',
    }],
    ['the recipient mutes the status author', {
      viewer_mutes_status_author: 1,
    }],
    ['the recipient blocks the status author', {
      viewer_blocks_status_author: 1,
    }],
    ['the recipient blocks the status author domain', {
      viewer_blocks_status_author_domain: 1,
    }],
    ['the status author blocks the recipient', {
      status_author_blocks_viewer: 1,
    }],
    ['the recipient muted the status thread', {
      viewer_mutes_status_thread: 1,
    }],
  ] satisfies [string, Partial<NotificationPermissionRow>][]) (
    'drops a delayed push before loading subscriptions when %s',
    async (_label, overrides) => {
      mocks.notificationRow = { ...validNotificationRow(), ...overrides };

      await handleSendWebPush({
        type: 'send_web_push',
        notificationId: 'notification-1',
        userId: 'recipient-user',
      });

      expect(mocks.queries).toHaveLength(1);
      expect(mocks.queries[0]).toContain('FROM notifications n');
      expect(mocks.queries[0]).toContain('status_mutes');
      expect(mocks.queries[0]).toContain('sender_mute.hide_notifications != 0');
      expect(mocks.queries[0]).toContain(
        'status_author_mute.hide_notifications != 0',
      );
      expect(mocks.sendPushNotification).not.toHaveBeenCalled();
    },
  );

  it('allows a delayed push from an active remote sender without a user row', async () => {
    mocks.notificationRow = {
      ...validNotificationRow(),
      sender_domain: 'remote.example',
      sender_user_disabled: null,
      sender_user_approved: null,
    };

    await handleSendWebPush({
      type: 'send_web_push',
      notificationId: 'notification-1',
      userId: 'recipient-user',
    });

    expect(mocks.sendPushNotification).toHaveBeenCalledTimes(1);
  });

  it('allows a delayed non-status notification after revalidation', async () => {
    mocks.notificationRow = {
      ...validNotificationRow(),
      notification_type: 'follow',
      status_id: null,
      status_account_id: null,
      status_visibility: null,
      status_username: null,
      status_domain: null,
    };

    await handleSendWebPush({
      type: 'send_web_push',
      notificationId: 'notification-1',
      userId: 'recipient-user',
    });

    expect(mocks.sendPushNotification).toHaveBeenCalledTimes(1);
  });

  it('allows a delayed push for a silenced status author followed by the recipient', async () => {
    mocks.notificationRow = {
      ...validNotificationRow(),
      status_author_silenced_at: '2026-07-15T00:00:00.000Z',
      viewer_follows_status_author: 1,
    };

    await handleSendWebPush({
      type: 'send_web_push',
      notificationId: 'notification-1',
      userId: 'recipient-user',
    });

    expect(mocks.sendPushNotification).toHaveBeenCalledTimes(1);
  });
});
