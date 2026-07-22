import { beforeEach, describe, expect, it, vi } from 'vitest';

interface StatusPermissionRow {
  account_id: string;
  visibility: string | null;
  deleted_at: string | null;
  reblog_of_id: string | null;
  quote_id: string | null;
  suspended_at: string | null;
  silenced_at: string | null;
  author_domain: string | null;
  sort_at_ms: number;
  source_version: number;
}

const mocks = vi.hoisted(() => ({
  statusRow: null as StatusPermissionRow | null,
  recipientRows: [] as { account_id: string }[],
  viewerBlockedRows: [] as { account_id: string }[],
  mutedRows: [] as { account_id: string }[],
  authorBlockedRows: [] as { account_id: string }[],
  domainBlockedRows: [] as { account_id: string }[],
  streamUserRows: [] as { id: string; account_id: string }[],
  queries: [] as string[],
  bindings: [] as (string | number)[][],
  env: {
    DB_META_C000: {
      prepare: vi.fn(),
      batch: vi.fn(),
    },
    INTERNAL_CONNECTION_MAIN: { sendStreamEvent: vi.fn() },
    INSTANCE_DOMAIN: 'local.example',
  },
  buildStatusStreamingPayload: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({ env: mocks.env }));
vi.mock('../../packages/shared/utils/streamingPayload', () => ({
  buildStatusStreamingPayload: mocks.buildStatusStreamingPayload,
}));

import { handleTimelineFanout } from '../src/handlers/timelineFanout';

function configureDatabase(): void {
  mocks.env.DB_META_C000.prepare.mockImplementation((sql: string) => ({
    bind: (...params: (string | number)[]) => {
      mocks.queries.push(sql);
      mocks.bindings.push(params);
      return {
        first: async () => {
          if (sql.includes('FROM statuses s')) return mocks.statusRow;
          throw new Error(`Unexpected first query: ${sql} (${params.join(',')})`);
        },
        all: async () => {
          if (sql.includes('FROM follows f')) {
            return { results: mocks.recipientRows };
          }
          if (sql.includes('SELECT target_account_id AS account_id')) {
            return { results: mocks.authorBlockedRows };
          }
          if (sql.includes('FROM users recipient_user')) {
            return { results: mocks.streamUserRows };
          }
          if (sql.includes('FROM blocks')) {
            return { results: mocks.viewerBlockedRows };
          }
          if (sql.includes('FROM mutes')) {
            return { results: mocks.mutedRows };
          }
          if (sql.includes('FROM user_domain_blocks')) {
            return { results: mocks.domainBlockedRows };
          }
          throw new Error(`Unexpected all query: ${sql} (${params.join(',')})`);
        },
      };
    },
  }));
}

function statusPermissionRow(
  overrides: Partial<StatusPermissionRow> = {},
): StatusPermissionRow {
  return {
    account_id: 'author-account',
    visibility: 'public',
    deleted_at: null,
    reblog_of_id: null,
    quote_id: null,
    suspended_at: null,
    silenced_at: null,
    author_domain: null,
    sort_at_ms: 1_753_000_000_000,
    source_version: 1,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.statusRow = null;
  mocks.recipientRows = [
    { account_id: 'follower-account' },
    { account_id: 'author-account' },
  ];
  mocks.viewerBlockedRows = [];
  mocks.mutedRows = [];
  mocks.authorBlockedRows = [];
  mocks.domainBlockedRows = [];
  mocks.streamUserRows = [
    { id: 'follower-user', account_id: 'follower-account' },
    { id: 'author-user', account_id: 'author-account' },
  ];
  mocks.queries.length = 0;
  mocks.bindings.length = 0;
  mocks.env.DB_META_C000.prepare.mockReset();
  mocks.env.DB_META_C000.batch.mockReset();
  mocks.env.DB_META_C000.batch.mockResolvedValue([]);
  mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent.mockReset();
  mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent.mockResolvedValue(undefined);
  mocks.buildStatusStreamingPayload.mockReset();
  mocks.buildStatusStreamingPayload.mockResolvedValue('{"id":"status-1"}');
  configureDatabase();
});

describe('timeline fanout permission binding', () => {
  it.each([
    ['missing status', null],
    [
      'message author mismatch',
      statusPermissionRow({ account_id: 'another-account' }),
    ],
    [
      'direct visibility',
      statusPermissionRow({ visibility: 'direct' }),
    ],
    [
      'invalid visibility',
      statusPermissionRow({ visibility: 'mystery' }),
    ],
    [
      'deleted status',
      statusPermissionRow({
        deleted_at: '2026-07-15T00:00:00.000Z',
      }),
    ],
    [
      'suspended author',
      statusPermissionRow({
        suspended_at: '2026-07-15T00:00:00.000Z',
      }),
    ],
  ] satisfies [string, StatusPermissionRow | null][])(
    'drops %s before loading recipients',
    async (_label, statusRow) => {
      mocks.statusRow = statusRow;

      await handleTimelineFanout({
        type: 'timeline_fanout',
        statusId: 'status-1',
        accountId: 'author-account',
      });

      expect(mocks.queries).toHaveLength(1);
      expect(mocks.queries[0]).toContain('FROM statuses s');
      expect(mocks.bindings[0]).toEqual(['status-1']);
      expect(mocks.env.DB_META_C000.batch).not.toHaveBeenCalled();
      expect(mocks.buildStatusStreamingPayload).not.toHaveBeenCalled();
      expect(mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent).not.toHaveBeenCalled();
    },
  );

  it('streams and materializes a matching active private status for its followers', async () => {
    mocks.statusRow = statusPermissionRow({
      visibility: 'private',
    });

    await handleTimelineFanout({
      type: 'timeline_fanout',
      statusId: 'status-1',
      accountId: 'author-account',
    });

    expect(mocks.env.DB_META_C000.batch).toHaveBeenCalledTimes(1);
    expect(mocks.buildStatusStreamingPayload).toHaveBeenNthCalledWith(
      1,
      mocks.env.DB_META_C000,
      'status-1',
      'local.example',
      { kind: 'account', accountId: 'follower-account' },
    );
    expect(mocks.buildStatusStreamingPayload).toHaveBeenCalledTimes(1);
    expect(mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent).toHaveBeenCalledTimes(2);
  });

  it('filters recipients blocked by the author even when the follow row is stale', async () => {
    mocks.statusRow = statusPermissionRow({ visibility: 'private' });
    mocks.authorBlockedRows = [{ account_id: 'follower-account' }];
    mocks.streamUserRows = [
      { id: 'author-user', account_id: 'author-account' },
    ];

    await handleTimelineFanout({
      type: 'timeline_fanout',
      statusId: 'status-1',
      accountId: 'author-account',
    });

    expect(mocks.env.DB_META_C000.batch).toHaveBeenCalledTimes(1);
    expect(mocks.streamUserRows).toEqual([
      { id: 'author-user', account_id: 'author-account' },
    ]);
    expect(
      mocks.queries.some((sql) =>
        sql.includes('SELECT target_account_id AS account_id')),
    ).toBe(true);
  });

  it('filters recipients that block the remote author domain', async () => {
    mocks.statusRow = statusPermissionRow({
      visibility: 'private',
      author_domain: 'blocked.example',
    });
    mocks.recipientRows = [{ account_id: 'follower-account' }];
    mocks.domainBlockedRows = [{ account_id: 'follower-account' }];
    mocks.streamUserRows = [];

    await handleTimelineFanout({
      type: 'timeline_fanout',
      statusId: 'status-1',
      accountId: 'author-account',
    });

    const domainQueryIndex = mocks.queries.findIndex((sql) =>
      sql.includes('FROM user_domain_blocks'));
    expect(domainQueryIndex).toBeGreaterThan(-1);
    expect(mocks.bindings[domainQueryIndex]).toEqual([
      'blocked.example',
      'follower-account',
    ]);
    expect(mocks.env.DB_META_C000.batch).not.toHaveBeenCalled();
    expect(mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['disabled users', 'recipient_user.disabled = 0'],
    ['unapproved users', 'recipient_user.approved = 1'],
    ['suspended recipient accounts', 'recipient.suspended_at IS NULL'],
    ['memorial recipient accounts', 'recipient.memorial = 0'],
  ])('excludes %s from stream recipient queries', async (_label, clause) => {
    mocks.statusRow = statusPermissionRow({ visibility: 'private' });
    mocks.recipientRows = [];

    await handleTimelineFanout({
      type: 'timeline_fanout',
      statusId: 'status-1',
      accountId: 'author-account',
    });

    expect(mocks.queries[1]).toContain(clause);
    expect(mocks.env.DB_META_C000.batch).not.toHaveBeenCalled();
    expect(mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent).not.toHaveBeenCalled();
  });

  it('rechecks recipient operational state in follower and stream lookups', async () => {
    mocks.statusRow = statusPermissionRow({ visibility: 'private' });

    await handleTimelineFanout({
      type: 'timeline_fanout',
      statusId: 'status-1',
      accountId: 'author-account',
    });

    const followerSql = mocks.queries.find((sql) =>
      sql.includes('FROM follows f'));
    const streamSql = mocks.queries.find((sql) =>
      sql.includes('FROM users recipient_user'));
    for (const clause of [
      'recipient_user.disabled = 0',
      'recipient_user.approved = 1',
      'recipient.suspended_at IS NULL',
      'recipient.memorial = 0',
    ]) {
      expect(followerSql).toContain(clause);
      expect(streamSql).toContain(clause);
    }
    for (const clause of [
      'author_block.account_id = ?',
      'viewer_block.account_id = recipient',
      'viewer_mute.account_id = recipient',
    ]) {
      expect(streamSql).toContain(clause);
    }
  });

  it('keeps follower and author delivery for a silenced author without public broadcast', async () => {
    mocks.statusRow = statusPermissionRow({
      visibility: 'public',
      silenced_at: '2026-07-15T00:00:00.000Z',
    });

    await handleTimelineFanout({
      type: 'timeline_fanout',
      statusId: 'status-1',
      accountId: 'author-account',
    });

    expect(mocks.env.DB_META_C000.batch).toHaveBeenCalledTimes(1);
    expect(mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent).toHaveBeenCalledTimes(2);
    expect(mocks.streamUserRows.map((row) => row.account_id)).toEqual([
      'follower-account',
      'author-account',
    ]);
  });

  it('broadcasts an eligible public status even with no local recipients', async () => {
    mocks.statusRow = statusPermissionRow({ author_domain: 'remote.example' });
    mocks.recipientRows = [];
    mocks.streamUserRows = [];

    await handleTimelineFanout({
      type: 'timeline_fanout',
      statusId: 'status-1',
      accountId: 'author-account',
    });

    expect(mocks.env.DB_META_C000.batch).toHaveBeenCalledTimes(1);
    expect(mocks.buildStatusStreamingPayload).toHaveBeenCalledTimes(1);
    expect(mocks.buildStatusStreamingPayload).toHaveBeenCalledWith(
      mocks.env.DB_META_C000,
      'status-1',
      'local.example',
      { kind: 'public' },
    );
    expect(mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent).toHaveBeenCalledTimes(1);
    expect(mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent).toHaveBeenCalledWith('__public__', {
      event: 'update',
      payload: '{"id":"status-1"}',
      stream: ['public'],
    });
  });

  it('builds recipient and public payloads against their distinct audiences', async () => {
    mocks.statusRow = statusPermissionRow({ reblog_of_id: 'nested-status' });
    mocks.buildStatusStreamingPayload.mockImplementation(
      async (_db, _statusId, _domain, audience: { kind: string; accountId?: string }) =>
        JSON.stringify({ audience: audience.accountId ?? audience.kind }),
    );

    await handleTimelineFanout({
      type: 'timeline_fanout',
      statusId: 'status-1',
      accountId: 'author-account',
    });

    expect(mocks.buildStatusStreamingPayload).toHaveBeenCalledTimes(3);
    const rpcCalls = mocks.env.INTERNAL_CONNECTION_MAIN.sendStreamEvent.mock.calls.map(
      ([userId, event]) => ({
        userId: userId as string,
        payload: (event as { payload: string }).payload,
      }),
    );
    expect(rpcCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        userId: 'follower-user',
        payload: '{"audience":"follower-account"}',
      }),
      expect.objectContaining({
        userId: 'author-user',
        payload: '{"audience":"author-account"}',
      }),
      expect.objectContaining({
        userId: '__public__',
        payload: '{"audience":"public"}',
      }),
    ]));
  });

  it('reuses one authorized payload for a plain status across recipients', async () => {
    mocks.statusRow = statusPermissionRow();

    await handleTimelineFanout({
      type: 'timeline_fanout',
      statusId: 'status-1',
      accountId: 'author-account',
    });

    expect(mocks.buildStatusStreamingPayload).toHaveBeenCalledTimes(2);
    expect(mocks.buildStatusStreamingPayload).toHaveBeenNthCalledWith(
      1,
      mocks.env.DB_META_C000,
      'status-1',
      'local.example',
      { kind: 'account', accountId: 'follower-account' },
    );
    expect(mocks.buildStatusStreamingPayload).toHaveBeenNthCalledWith(
      2,
      mocks.env.DB_META_C000,
      'status-1',
      'local.example',
      { kind: 'public' },
    );
  });
});
