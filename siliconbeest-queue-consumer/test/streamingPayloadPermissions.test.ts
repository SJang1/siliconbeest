import { beforeEach, describe, expect, it, vi } from 'vitest';

const emojiMocks = vi.hoisted(() => ({
  fetchEmojisForStatus: vi.fn(async () => []),
  fetchAccountEmojis: vi.fn(async () => []),
}));

vi.mock('../../packages/shared/utils/emoji', () => emojiMocks);

import { buildStatusStreamingPayload } from '../../packages/shared/utils/streamingPayload';

type BindValue = string | number | null;

interface StreamingStatusRecord {
  id: string;
  uri: string;
  object_type: 'Note' | 'Article';
  title: string;
  poll_id: string | null;
  content: string;
  visibility: string;
  sensitive: number;
  content_warning: string | null;
  language: string | null;
  url: string | null;
  created_at: string;
  in_reply_to_id: string | null;
  in_reply_to_account_id: string | null;
  reblog_of_id: string | null;
  quote_id: string | null;
  quote_approval_status: string | null;
  quote_policy: string | null;
  reblogs_count: number;
  favourites_count: number;
  replies_count: number;
  edited_at: string | null;
  deleted_at: string | null;
  account_id: string;
  username: string;
  domain: string | null;
  display_name: string | null;
  account_note: string | null;
  account_url: string | null;
  account_uri: string | null;
  avatar_url: string | null;
  header_url: string | null;
  locked: number;
  bot: number;
  followers_count: number;
  following_count: number;
  statuses_count: number;
  account_created_at: string;
  account_suspended_at: string | null;
  account_silenced_at: string | null;
  account_memorial: number;
  viewer_follows_author: number;
  viewer_is_mentioned: number;
  viewer_mutes_author: number;
  viewer_blocks_author: number;
  viewer_blocks_author_domain: number;
  author_blocks_viewer: number;
}

interface StreamingPayloadShape {
  id: string;
  object_type: 'Note' | 'Article' | 'Question';
  reblog: { id: string } | null;
  quote: { id: string } | null;
}

function statusRecord(
  id: string,
  overrides: Partial<StreamingStatusRecord> = {},
): StreamingStatusRecord {
  return {
    id,
    uri: `https://remote.example/statuses/${id}`,
    object_type: 'Note',
    title: '',
    poll_id: null,
    content: `<p>${id}</p>`,
    visibility: 'public',
    sensitive: 0,
    content_warning: null,
    language: 'en',
    url: `https://remote.example/@author/${id}`,
    created_at: '2026-07-15T00:00:00.000Z',
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    reblog_of_id: null,
    quote_id: null,
    quote_approval_status: null,
    quote_policy: 'public',
    reblogs_count: 0,
    favourites_count: 0,
    replies_count: 0,
    edited_at: null,
    deleted_at: null,
    account_id: `${id}-author`,
    username: `${id}-author`,
    domain: 'remote.example',
    display_name: id,
    account_note: '',
    account_url: `https://remote.example/@${id}-author`,
    account_uri: `https://remote.example/users/${id}-author`,
    avatar_url: null,
    header_url: null,
    locked: 0,
    bot: 0,
    followers_count: 0,
    following_count: 0,
    statuses_count: 1,
    account_created_at: '2026-07-01T00:00:00.000Z',
    account_suspended_at: null,
    account_silenced_at: null,
    account_memorial: 0,
    viewer_follows_author: 0,
    viewer_is_mentioned: 0,
    viewer_mutes_author: 0,
    viewer_blocks_author: 0,
    viewer_blocks_author_domain: 0,
    author_blocks_viewer: 0,
    ...overrides,
  };
}

function databaseForRows(rows: StreamingStatusRecord[]): {
  db: D1Database;
  queries: string[];
  bindings: BindValue[][];
} {
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const queries: string[] = [];
  const bindings: BindValue[][] = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...params: BindValue[]) => {
      queries.push(sql);
      bindings.push(params);
      return {
        first: async () => rowsById.get(String(params[0])) ?? null,
        all: async () => ({ results: [] }),
      };
    },
  }));

  return {
    db: { prepare } as unknown as D1Database,
    queries,
    bindings,
  };
}

function parsePayload(payload: string | null): StreamingPayloadShape {
  expect(payload).not.toBeNull();
  return JSON.parse(payload as string) as StreamingPayloadShape;
}

beforeEach(() => {
  emojiMocks.fetchEmojisForStatus.mockClear();
  emojiMocks.fetchAccountEmojis.mockClear();
});

describe('streaming payload nested status permissions', () => {
  it('does not expose a non-public reblog target to a public stream', async () => {
    const wrapper = statusRecord('wrapper', { reblog_of_id: 'original' });
    const original = statusRecord('original', { visibility: 'unlisted' });
    const { db } = databaseForRows([wrapper, original]);

    const payload = parsePayload(await buildStatusStreamingPayload(
      db,
      wrapper.id,
      'local.example',
      { kind: 'public' },
    ));

    expect(payload.id).toBe(wrapper.id);
    expect(payload.reblog).toBeNull();
  });

  it.each([
    ['deleted', { deleted_at: '2026-07-15T01:00:00.000Z' }],
    ['suspended', { account_suspended_at: '2026-07-15T01:00:00.000Z' }],
    ['silenced', { account_silenced_at: '2026-07-15T01:00:00.000Z' }],
  ] satisfies Array<[string, Partial<StreamingStatusRecord>]>)(
    'does not expose a %s reblog target to a public stream',
    async (_label, targetOverrides) => {
      const wrapper = statusRecord('wrapper', { reblog_of_id: 'original' });
      const original = statusRecord('original', targetOverrides);
      const { db } = databaseForRows([wrapper, original]);

      const payload = parsePayload(await buildStatusStreamingPayload(
        db,
        wrapper.id,
        'local.example',
        { kind: 'public' },
      ));

      expect(payload.reblog).toBeNull();
    },
  );

  it.each([
    ['mutes', { viewer_mutes_author: 1 }],
    ['blocks', { viewer_blocks_author: 1 }],
    ['domain-blocks', { viewer_blocks_author_domain: 1 }],
    ['is blocked by', { author_blocks_viewer: 1 }],
  ] satisfies Array<[string, Partial<StreamingStatusRecord>]>)(
    'does not expose a reblog target when the recipient %s its author',
    async (_label, targetOverrides) => {
      const wrapper = statusRecord('wrapper', { reblog_of_id: 'original' });
      const original = statusRecord('original', targetOverrides);
      const { db } = databaseForRows([wrapper, original]);

      const payload = parsePayload(await buildStatusStreamingPayload(
        db,
        wrapper.id,
        'local.example',
        { kind: 'account', accountId: 'viewer-account' },
      ));

      expect(payload.reblog).toBeNull();
    },
  );

  it('preserves a visible reblog target for an allowed recipient', async () => {
    const wrapper = statusRecord('wrapper', { reblog_of_id: 'original' });
    const original = statusRecord('original');
    const { db } = databaseForRows([wrapper, original]);

    const payload = parsePayload(await buildStatusStreamingPayload(
      db,
      wrapper.id,
      'local.example',
      { kind: 'account', accountId: 'viewer-account' },
    ));

    expect(payload.reblog?.id).toBe(original.id);
  });

  it('applies visibility per audience when serializing a quote target', async () => {
    const wrapper = statusRecord('wrapper', {
      quote_id: 'quoted',
      quote_approval_status: 'accepted',
    });
    const quotedForPublic = statusRecord('quoted', {
      visibility: 'private',
      viewer_follows_author: 1,
    });
    const publicDatabase = databaseForRows([wrapper, quotedForPublic]);

    const publicPayload = parsePayload(await buildStatusStreamingPayload(
      publicDatabase.db,
      wrapper.id,
      'local.example',
      { kind: 'public' },
    ));
    expect(publicPayload.quote).toBeNull();

    const accountDatabase = databaseForRows([wrapper, quotedForPublic]);
    const accountPayload = parsePayload(await buildStatusStreamingPayload(
      accountDatabase.db,
      wrapper.id,
      'local.example',
      { kind: 'account', accountId: 'viewer-account' },
    ));
    expect(accountPayload.quote?.id).toBe('quoted');
  });

  it('includes an accepted unlisted quote in a public wrapper without treating it as a reblog', async () => {
    const wrapper = statusRecord('wrapper', {
      quote_id: 'quoted',
      quote_approval_status: 'accepted',
    });
    const quoted = statusRecord('quoted', { visibility: 'unlisted' });
    const { db } = databaseForRows([wrapper, quoted]);

    const payload = parsePayload(await buildStatusStreamingPayload(
      db,
      wrapper.id,
      'local.example',
      { kind: 'public' },
    ));

    expect(payload.quote?.id).toBe(quoted.id);
  });

  it.each(['pending', 'rejected', 'revoked', 'none'])(
    'does not embed a %s quote relationship',
    async (quoteApprovalStatus) => {
      const wrapper = statusRecord('wrapper', {
        quote_id: 'quoted',
        quote_approval_status: quoteApprovalStatus,
      });
      const quoted = statusRecord('quoted');
      const { db } = databaseForRows([wrapper, quoted]);

      const payload = parsePayload(await buildStatusStreamingPayload(
        db,
        wrapper.id,
        'local.example',
        { kind: 'public' },
      ));

      expect(payload.quote).toBeNull();
    },
  );

  it('rejects a primary status that is not eligible for the requested stream', async () => {
    const privateStatus = statusRecord('private', { visibility: 'private' });
    const { db } = databaseForRows([privateStatus]);

    await expect(buildStatusStreamingPayload(
      db,
      privateStatus.id,
      'local.example',
      { kind: 'public' },
    )).resolves.toBeNull();
    expect(emojiMocks.fetchEmojisForStatus).not.toHaveBeenCalled();
  });

  it('binds SQL-shaped status and account IDs without interpolating them', async () => {
    const statusId = "status'); DROP TABLE statuses; --";
    const accountId = "viewer'); DROP TABLE accounts; --";
    const wrapper = statusRecord(statusId);
    const { db, queries, bindings } = databaseForRows([wrapper]);

    await expect(buildStatusStreamingPayload(
      db,
      statusId,
      'local.example',
      { kind: 'account', accountId },
    )).resolves.not.toBeNull();

    expect(queries.every((sql) => !sql.includes(statusId))).toBe(true);
    expect(queries.every((sql) => !sql.includes(accountId))).toBe(true);
    expect(bindings[0]?.[0]).toBe(statusId);
    expect(bindings[0]?.[1]).toBe(accountId);
  });

  it('selects poll ids so streaming polls keep the Question object type', async () => {
    const poll = statusRecord('poll', { poll_id: 'poll-id' });
    const { db, queries } = databaseForRows([poll]);

    const payload = parsePayload(await buildStatusStreamingPayload(
      db,
      poll.id,
      'local.example',
      { kind: 'public' },
    ));

    expect(payload.object_type).toBe('Question');
    expect(queries.some(sql => sql.includes('s.poll_id'))).toBe(true);
  });
});
