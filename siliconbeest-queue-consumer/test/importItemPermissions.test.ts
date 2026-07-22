import { beforeEach, describe, expect, it, vi } from 'vitest';

type SqlBinding = string | number | null;

interface BoundStatement {
  sql: string;
  bindings: SqlBinding[];
}

interface TargetRow {
  id: string;
  username: string;
  domain: string | null;
  uri: string;
  inbox_url: string | null;
  shared_inbox_url: string | null;
  locked: number;
  manually_approves_followers: number;
  suspended_at: string | null;
  memorial: number;
  moved_to_account_id: string | null;
  user_approved: number | null;
}

interface ActorPermissionRow {
  suspended_at: string | null;
  memorial: number;
  user_disabled: number;
  user_approved: number;
  actor_blocks_target: number;
  target_blocks_actor: number;
  actor_blocks_target_domain: number;
}

const mocks = vi.hoisted(() => ({
  env: {
    DB_META_C000: {
      prepare: vi.fn(),
      batch: vi.fn(),
    },
    QUEUE_INTERNAL: { send: vi.fn() },
    QUEUE_FEDERATION: { send: vi.fn() },
  },
  targetRow: null as TargetRow | null,
  actorRow: null as ActorPermissionRow | null,
  insertChanges: 1,
  getSuspendedDomains: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({ env: mocks.env }));
vi.mock('../../packages/shared/domain-blocks', () => ({
  getSuspendedDomains: mocks.getSuspendedDomains,
}));

import { handleImportItem } from '../src/handlers/importItem';

function activeTarget(overrides: Partial<TargetRow> = {}): TargetRow {
  return {
    id: 'target-account',
    username: 'target',
    domain: null,
    uri: 'https://local.example/users/target',
    inbox_url: null,
    shared_inbox_url: null,
    locked: 0,
    manually_approves_followers: 0,
    suspended_at: null,
    memorial: 0,
    moved_to_account_id: null,
    user_approved: 1,
    ...overrides,
  };
}

function activeActor(overrides: Partial<ActorPermissionRow> = {}): ActorPermissionRow {
  return {
    suspended_at: null,
    memorial: 0,
    user_disabled: 0,
    user_approved: 1,
    actor_blocks_target: 0,
    target_blocks_actor: 0,
    actor_blocks_target_domain: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.targetRow = activeTarget();
  mocks.actorRow = activeActor();
  mocks.insertChanges = 1;
  mocks.env.DB_META_C000.prepare.mockReset();
  mocks.env.DB_META_C000.batch.mockReset();
  mocks.env.DB_META_C000.batch.mockResolvedValue([]);
  mocks.env.QUEUE_INTERNAL.send.mockReset();
  mocks.env.QUEUE_FEDERATION.send.mockReset();
  mocks.getSuspendedDomains.mockReset();
  mocks.getSuspendedDomains.mockResolvedValue(new Set<string>());

  mocks.env.DB_META_C000.prepare.mockImplementation((sql: string) => ({
    bind: (...bindings: SqlBinding[]) => {
      const statement: BoundStatement = { sql, bindings };
      return {
        ...statement,
        first: async () => {
          if (sql.includes('FROM accounts target')) return mocks.targetRow;
          if (sql.includes('FROM accounts importing_actor')) return mocks.actorRow;
          if (sql.includes('FROM accounts actor')) return mocks.actorRow;
          if (sql.includes('FROM follows')) return null;
          if (sql.includes('FROM follow_requests')) return null;
          if (sql.includes('SELECT id, username, uri FROM accounts')) {
            return {
              id: 'local-account',
              username: 'local',
              uri: 'https://local.example/users/local',
            };
          }
          if (sql.includes('FROM mutes')) return null;
          throw new Error(`Unexpected first query: ${sql}`);
        },
        run: async () => ({ meta: { changes: mocks.insertChanges } }),
      };
    },
  }));
});

describe('import relationship permissions', () => {
  it('does not perform remote discovery for an inactive importing account', async () => {
    mocks.targetRow = null;
    mocks.actorRow = activeActor({ user_disabled: 1 });

    await handleImportItem({
      type: 'import_item',
      acct: 'target@remote.example',
      action: 'following',
      accountId: 'local-account',
    });

    expect(mocks.getSuspendedDomains).not.toHaveBeenCalled();
    expect(mocks.env.QUEUE_INTERNAL.send).not.toHaveBeenCalled();
    expect(mocks.env.QUEUE_FEDERATION.send).not.toHaveBeenCalled();
  });

  it.each(['blocks', 'mutes'] as const)(
    'does not import %s for a disabled account',
    async (action) => {
      mocks.actorRow = activeActor({ user_disabled: 1 });

      await handleImportItem({
        type: 'import_item',
        acct: 'target',
        action,
        accountId: 'local-account',
      });

      expect(mocks.env.DB_META_C000.batch).not.toHaveBeenCalled();
      expect(mocks.env.DB_META_C000.prepare).toHaveBeenCalledTimes(2);
    },
  );

  it('tears down both directions and all derived relationships when importing a block', async () => {
    await handleImportItem({
      type: 'import_item',
      acct: 'target',
      action: 'blocks',
      accountId: 'local-account',
    });

    expect(mocks.env.DB_META_C000.batch).toHaveBeenCalledTimes(1);
    const statements = mocks.env.DB_META_C000.batch.mock.calls[0][0] as BoundStatement[];
    const sql = statements.map((statement) => statement.sql);

    expect(sql).toHaveLength(12);
    expect(sql.filter((query) => query.includes('UPDATE accounts'))).toHaveLength(4);
    expect(
      sql
        .filter((query) => query.includes('UPDATE accounts'))
        .every((query) => query.includes('EXISTS')),
    ).toBe(true);
    expect(sql.filter((query) => query.includes('DELETE FROM follows'))).toHaveLength(2);
    expect(sql.filter((query) => query.includes('DELETE FROM follow_requests'))).toHaveLength(2);
    expect(sql.filter((query) => query.includes('DELETE FROM list_accounts'))).toHaveLength(2);
    expect(sql.filter((query) => query.includes('DELETE FROM account_pins'))).toHaveLength(1);
    expect(sql.every((query) => !query.includes('local-account'))).toBe(true);
    expect(sql.every((query) => !query.includes('target-account'))).toBe(true);
  });

  it('allows an active user to block a cached suspended target defensively', async () => {
    mocks.targetRow = activeTarget({
      suspended_at: '2026-07-15T00:00:00.000Z',
    });

    await handleImportItem({
      type: 'import_item',
      acct: 'target',
      action: 'blocks',
      accountId: 'local-account',
    });

    expect(mocks.env.DB_META_C000.batch).toHaveBeenCalledTimes(1);
  });

  it('keeps user domain blocks exact instead of inheriting them to subdomains', async () => {
    mocks.targetRow = activeTarget({
      domain: 'sub.user-blocked.example',
      uri: 'https://sub.user-blocked.example/users/target',
      inbox_url: 'https://sub.user-blocked.example/inbox',
      user_approved: null,
    });

    await handleImportItem({
      type: 'import_item',
      acct: 'target@sub.user-blocked.example',
      action: 'following',
      accountId: 'local-account',
    });

    const actorQuery = mocks.env.DB_META_C000.prepare.mock.calls
      .map(([sql]) => sql as string)
      .find((sql) => sql.includes('actor_domain_block'));
    expect(actorQuery).toContain('lower(?3) = lower(actor_domain_block.domain)');
    expect(actorQuery).not.toContain('LIKE');
    expect(mocks.env.QUEUE_FEDERATION.send).toHaveBeenCalledTimes(1);
  });

  it('binds SQL-shaped account names and ids without rejecting the relationship', async () => {
    const sqlUsername = "target' OR 1=1 --";
    const sqlActorId = "actor'); DELETE FROM accounts; --";
    const sqlTargetId = "target' UNION SELECT id FROM users --";
    mocks.targetRow = activeTarget({
      id: sqlTargetId,
      username: sqlUsername,
    });

    await handleImportItem({
      type: 'import_item',
      acct: sqlUsername,
      action: 'blocks',
      accountId: sqlActorId,
    });

    expect(mocks.env.DB_META_C000.batch).toHaveBeenCalledTimes(1);
    const preparedSql = mocks.env.DB_META_C000.prepare.mock.calls
      .map(([sql]) => sql as string);
    expect(preparedSql.every((sql) => !sql.includes(sqlUsername))).toBe(true);
    expect(preparedSql.every((sql) => !sql.includes(sqlActorId))).toBe(true);
    expect(preparedSql.every((sql) => !sql.includes(sqlTargetId))).toBe(true);
  });

  it('does not increment follow counters when a concurrent insert changed no row', async () => {
    mocks.insertChanges = 0;

    await handleImportItem({
      type: 'import_item',
      acct: 'target',
      action: 'following',
      accountId: 'local-account',
    });

    expect(mocks.env.DB_META_C000.batch).not.toHaveBeenCalled();
    expect(mocks.env.QUEUE_FEDERATION.send).not.toHaveBeenCalled();
  });
});
