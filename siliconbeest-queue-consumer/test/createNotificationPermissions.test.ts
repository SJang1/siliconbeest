import { beforeEach, describe, expect, it, vi } from 'vitest';

interface NotificationPermissionRow {
  recipient_domain: string | null;
  recipient_suspended_at: string | null;
  recipient_memorial: number;
  recipient_user_id: string;
  recipient_user_disabled: number;
  recipient_user_approved: number;
  sender_domain: string | null;
  sender_suspended_at: string | null;
  sender_memorial: number;
  sender_user_disabled: number | null;
  sender_user_approved: number | null;
  viewer_mutes_sender: number;
  viewer_blocks_sender: number;
  viewer_blocks_sender_domain: number;
  sender_blocks_viewer: number;
  viewer_mutes_status_thread: number;
  status_id: string | null;
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
}

interface PermissionDenialCase {
  label: string;
  statusId?: string;
  row: NotificationPermissionRow | null;
}

const mocks = vi.hoisted(() => ({
  permissionRow: null as NotificationPermissionRow | null,
  statusRow: null as { id: string; account_id: string } | null,
  queries: [] as string[],
  bindings: [] as (string | number | null)[][],
  insertRuns: 0,
  env: {
    DB_META_C000: { prepare: vi.fn() },
    QUEUE_INTERNAL: { send: vi.fn() },
    INTERNAL_CONNECTION_MAIN: { sendStreamEvent: vi.fn() },
    INSTANCE_DOMAIN: 'local.example',
  },
  generateUlid: vi.fn(() => 'notification-1'),
  serializeAccount: vi.fn((account: { id: string }) => ({ id: account.id })),
  serializeStatus: vi.fn((status: { id: string }) => ({ id: status.id })),
}));

vi.mock('cloudflare:workers', () => ({ env: mocks.env }));
vi.mock('../../packages/shared/utils/ulid', () => ({
  generateUlid: mocks.generateUlid,
}));
vi.mock('../../packages/shared/serializers/mastodonSerializer', () => ({
  serializeAccount: mocks.serializeAccount,
  serializeStatus: mocks.serializeStatus,
}));

import { handleCreateNotification } from '../src/handlers/createNotification';

function operationalPermissionRow(): NotificationPermissionRow {
  return {
    recipient_domain: null,
    recipient_suspended_at: null,
    recipient_memorial: 0,
    recipient_user_id: 'recipient-user',
    recipient_user_disabled: 0,
    recipient_user_approved: 1,
    sender_domain: null,
    sender_suspended_at: null,
    sender_memorial: 0,
    sender_user_disabled: 0,
    sender_user_approved: 1,
    viewer_mutes_sender: 0,
    viewer_blocks_sender: 0,
    viewer_blocks_sender_domain: 0,
    sender_blocks_viewer: 0,
    viewer_mutes_status_thread: 0,
    status_id: null,
    status_account_id: null,
    status_visibility: null,
    status_deleted_at: null,
    status_author_suspended_at: null,
    status_author_silenced_at: null,
    viewer_follows_status_author: 0,
    viewer_is_mentioned: 0,
    viewer_mutes_status_author: 0,
    viewer_blocks_status_author: 0,
    viewer_blocks_status_author_domain: 0,
    status_author_blocks_viewer: 0,
  };
}

function statusPermissionRow(
  overrides: Partial<NotificationPermissionRow> = {},
): NotificationPermissionRow {
  return {
    ...operationalPermissionRow(),
    status_id: 'status-1',
    status_account_id: 'sender-account',
    status_visibility: 'public',
    ...overrides,
  };
}

function configureDatabase(): void {
  mocks.env.DB_META_C000.prepare.mockImplementation((sql: string) => ({
    bind: (...params: (string | number | null)[]) => ({
      first: async () => {
        mocks.queries.push(sql);
        mocks.bindings.push(params);

        if (sql.includes('SELECT recipient.domain')) {
          return mocks.permissionRow;
        }
        if (sql.includes('SELECT id FROM notifications')) return null;
        if (sql.includes('FROM web_push_subscriptions')) {
          return { id: 'push-subscription-1' };
        }
        if (sql.includes('FROM accounts WHERE id')) {
          return { id: String(params[0]) };
        }
        if (sql.includes('FROM statuses WHERE id')) return mocks.statusRow;
        throw new Error(`Unexpected first query: ${sql}`);
      },
      run: async () => {
        mocks.queries.push(sql);
        mocks.bindings.push(params);
        if (!sql.includes('INSERT INTO notifications')) {
          throw new Error(`Unexpected run query: ${sql}`);
        }
        mocks.insertRuns += 1;
        return { success: true };
      },
    }),
  }));
}

beforeEach(() => {
  mocks.permissionRow = null;
  mocks.statusRow = null;
  mocks.queries.length = 0;
  mocks.bindings.length = 0;
  mocks.insertRuns = 0;
  mocks.env.DB_META_C000.prepare.mockReset();
  mocks.env.QUEUE_INTERNAL.send.mockReset();
  mocks.env.QUEUE_INTERNAL.send.mockResolvedValue(undefined);
  mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent.mockReset();
  mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent.mockResolvedValue(undefined);
  mocks.generateUlid.mockClear();
  mocks.serializeAccount.mockClear();
  mocks.serializeStatus.mockClear();
  configureDatabase();
});

const relationshipAndAccountDenials: PermissionDenialCase[] = [
  { label: 'the recipient does not resolve to a local user', row: null },
  {
    label: 'the recipient account is remote',
    row: { ...operationalPermissionRow(), recipient_domain: 'remote.example' },
  },
  {
    label: 'the recipient user is disabled',
    row: { ...operationalPermissionRow(), recipient_user_disabled: 1 },
  },
  {
    label: 'the recipient user is unapproved',
    row: { ...operationalPermissionRow(), recipient_user_approved: 0 },
  },
  {
    label: 'the recipient account is suspended',
    row: {
      ...operationalPermissionRow(),
      recipient_suspended_at: '2026-07-15T00:00:00.000Z',
    },
  },
  {
    label: 'the recipient account is memorialized',
    row: { ...operationalPermissionRow(), recipient_memorial: 1 },
  },
  {
    label: 'the sender account is suspended',
    row: {
      ...operationalPermissionRow(),
      sender_suspended_at: '2026-07-15T00:00:00.000Z',
    },
  },
  {
    label: 'the sender account is memorialized',
    row: { ...operationalPermissionRow(), sender_memorial: 1 },
  },
  {
    label: 'the local sender user is disabled',
    row: { ...operationalPermissionRow(), sender_user_disabled: 1 },
  },
  {
    label: 'the local sender user is unapproved',
    row: { ...operationalPermissionRow(), sender_user_approved: 0 },
  },
  {
    label: 'the recipient actively mutes sender notifications by default',
    row: { ...operationalPermissionRow(), viewer_mutes_sender: 1 },
  },
  {
    label: 'the recipient blocks the sender',
    row: { ...operationalPermissionRow(), viewer_blocks_sender: 1 },
  },
  {
    label: 'the recipient blocks the sender domain',
    row: { ...operationalPermissionRow(), viewer_blocks_sender_domain: 1 },
  },
  {
    label: 'the sender blocks the recipient',
    row: { ...operationalPermissionRow(), sender_blocks_viewer: 1 },
  },
];

const statusDenials: PermissionDenialCase[] = [
  {
    label: 'the status is missing',
    statusId: 'status-1',
    row: operationalPermissionRow(),
  },
  {
    label: 'the status visibility is invalid',
    statusId: 'status-1',
    row: statusPermissionRow({ status_visibility: 'mystery' }),
  },
  {
    label: 'the status is deleted',
    statusId: 'status-1',
    row: statusPermissionRow({
      status_deleted_at: '2026-07-15T00:00:00.000Z',
    }),
  },
  {
    label: 'the recipient cannot view a private status',
    statusId: 'status-1',
    row: statusPermissionRow({ status_visibility: 'private' }),
  },
  {
    label: 'the recipient is not mentioned by a direct status',
    statusId: 'status-1',
    row: statusPermissionRow({ status_visibility: 'direct' }),
  },
  {
    label: 'the recipient muted the exact status or its thread',
    statusId: 'status-1',
    row: statusPermissionRow({ viewer_mutes_status_thread: 1 }),
  },
  {
    label: 'the status author is suspended',
    statusId: 'status-1',
    row: statusPermissionRow({
      status_author_suspended_at: '2026-07-15T00:00:00.000Z',
    }),
  },
  {
    label: 'the status author is silenced and not followed',
    statusId: 'status-1',
    row: statusPermissionRow({
      status_author_silenced_at: '2026-07-15T00:00:00.000Z',
    }),
  },
  {
    label: 'the recipient actively mutes the status author',
    statusId: 'status-1',
    row: statusPermissionRow({ viewer_mutes_status_author: 1 }),
  },
  {
    label: 'the recipient blocks the status author',
    statusId: 'status-1',
    row: statusPermissionRow({ viewer_blocks_status_author: 1 }),
  },
  {
    label: 'the recipient blocks the status author domain',
    statusId: 'status-1',
    row: statusPermissionRow({ viewer_blocks_status_author_domain: 1 }),
  },
  {
    label: 'the status author blocks the recipient',
    statusId: 'status-1',
    row: statusPermissionRow({ status_author_blocks_viewer: 1 }),
  },
];

describe('notification delivery permissions', () => {
  it.each(relationshipAndAccountDenials)(
    'drops before insert, push, and stream when $label',
    async ({ statusId, row }) => {
      mocks.permissionRow = row;

      await handleCreateNotification({
        type: 'create_notification',
        recipientAccountId: 'recipient-account',
        senderAccountId: 'sender-account',
        notificationType: 'follow',
        ...(statusId ? { statusId } : {}),
      });

      expect(mocks.queries).toHaveLength(1);
      expect(mocks.insertRuns).toBe(0);
      expect(mocks.env.QUEUE_INTERNAL.send).not.toHaveBeenCalled();
      expect(mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent).not.toHaveBeenCalled();
    },
  );

  it.each(statusDenials)(
    'drops before insert, push, and stream when $label',
    async ({ statusId, row }) => {
      mocks.permissionRow = row;

      await handleCreateNotification({
        type: 'create_notification',
        recipientAccountId: 'recipient-account',
        senderAccountId: 'sender-account',
        notificationType: 'mention',
        ...(statusId ? { statusId } : {}),
      });

      expect(mocks.queries).toHaveLength(1);
      expect(mocks.insertRuns).toBe(0);
      expect(mocks.env.QUEUE_INTERNAL.send).not.toHaveBeenCalled();
      expect(mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent).not.toHaveBeenCalled();
    },
  );

  it('creates, pushes, and streams an allowed non-status notification', async () => {
    mocks.permissionRow = operationalPermissionRow();

    await handleCreateNotification({
      type: 'create_notification',
      recipientAccountId: 'recipient-account',
      senderAccountId: 'sender-account',
      notificationType: 'follow',
    });

    expect(mocks.insertRuns).toBe(1);
    expect(mocks.env.QUEUE_INTERNAL.send).toHaveBeenCalledWith({
      type: 'send_web_push',
      notificationId: 'notification-1',
      userId: 'recipient-user',
    });
    expect(mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent).toHaveBeenCalledTimes(1);
    expect(mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent).toHaveBeenCalledWith(
      'recipient-user',
      expect.objectContaining({
        event: 'notification',
        stream: ['user', 'user:notification'],
      }),
    );
    const [, event] = mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent.mock.calls[0] as [
      string,
      { payload: string },
    ];
    expect(JSON.parse(event.payload)).toMatchObject({
      id: 'notification-1',
      type: 'follow',
      account: { id: 'sender-account' },
    });
  });

  it('allows an active remote sender without a local user row', async () => {
    mocks.permissionRow = {
      ...operationalPermissionRow(),
      sender_domain: 'remote.example',
      sender_user_disabled: null,
      sender_user_approved: null,
    };

    await handleCreateNotification({
      type: 'create_notification',
      recipientAccountId: 'recipient-account',
      senderAccountId: 'sender-account',
      notificationType: 'follow',
    });

    expect(mocks.insertRuns).toBe(1);
    expect(mocks.env.QUEUE_INTERNAL.send).toHaveBeenCalledTimes(1);
    expect(mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent).toHaveBeenCalledTimes(1);
  });

  it('allows notifications when an account mute keeps notifications enabled', async () => {
    // The permission query returns false for viewer_mutes_sender when the
    // matching mute has hide_notifications = 0.
    mocks.permissionRow = {
      ...operationalPermissionRow(),
      viewer_mutes_sender: 0,
    };

    await handleCreateNotification({
      type: 'create_notification',
      recipientAccountId: 'recipient-account',
      senderAccountId: 'sender-account',
      notificationType: 'follow',
    });

    expect(mocks.queries[0]).toContain('mute.hide_notifications != 0');
    expect(mocks.queries[0]).toContain(
      'status_author_mute.hide_notifications != 0',
    );
    expect(mocks.insertRuns).toBe(1);
    expect(mocks.env.QUEUE_INTERNAL.send).toHaveBeenCalledTimes(1);
    expect(mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'a private status authored by the recipient',
      statusPermissionRow({
        status_account_id: 'recipient-account',
        status_visibility: 'private',
      }),
    ],
    [
      'a private status followed by the recipient',
      statusPermissionRow({
        status_visibility: 'private',
        viewer_follows_status_author: 1,
      }),
    ],
    [
      'a direct status that exactly mentions the recipient',
      statusPermissionRow({
        status_visibility: 'direct',
        viewer_is_mentioned: 1,
      }),
    ],
    [
      'a public status from a silenced author followed by the recipient',
      statusPermissionRow({
        status_author_silenced_at: '2026-07-15T00:00:00.000Z',
        viewer_follows_status_author: 1,
      }),
    ],
    [
      'a status whose author differs from the notification sender',
      statusPermissionRow({ status_account_id: 'status-author-account' }),
    ],
  ] satisfies [string, NotificationPermissionRow][])(
    'creates, pushes, and streams an allowed notification for %s',
    async (_label, row) => {
      mocks.permissionRow = row;
      mocks.statusRow = {
        id: 'status-1',
        account_id: row.status_account_id ?? 'sender-account',
      };

      await handleCreateNotification({
        type: 'create_notification',
        recipientAccountId: 'recipient-account',
        senderAccountId: 'sender-account',
        notificationType: 'favourite',
        statusId: 'status-1',
      });

      expect(mocks.insertRuns).toBe(1);
      expect(mocks.env.QUEUE_INTERNAL.send).toHaveBeenCalledTimes(1);
      expect(mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent).toHaveBeenCalledTimes(1);
      expect(mocks.serializeStatus).toHaveBeenCalledTimes(1);
    },
  );

  it('queries active sender mutes and exact-or-conversation status mutes', async () => {
    mocks.permissionRow = operationalPermissionRow();

    await handleCreateNotification({
      type: 'create_notification',
      recipientAccountId: 'recipient-account',
      senderAccountId: 'sender-account',
      notificationType: 'follow',
    });

    expect(mocks.queries[0]).toContain('mute.expires_at > ?4');
    expect(mocks.queries[0]).toContain('mute.hide_notifications != 0');
    expect(mocks.queries[0]).toContain('status_mute.status_id = status.id');
    expect(mocks.queries[0]).toContain('status.conversation_id IS NOT NULL');
    expect(mocks.queries[0]).toContain('status_author_mute.expires_at > ?4');
    expect(mocks.queries[0]).toContain('sender_user.approved');
    expect(mocks.bindings[0]?.slice(0, 3)).toEqual([
      'recipient-account',
      'sender-account',
      null,
    ]);
  });
});
