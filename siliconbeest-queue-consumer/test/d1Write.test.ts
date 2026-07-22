import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1WriteMessage, SqlWriteStatement } from '../../packages/shared/types/write';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  metaPrepare: vi.fn(),
  batch: vi.fn(),
  claimWriteOperation: vi.fn(),
  updateWriteOperation: vi.fn(),
  internalSend: vi.fn(),
  federationSend: vi.fn(),
  env: {} as Record<string, unknown>,
}));

vi.mock('cloudflare:workers', () => ({ env: mocks.env }));

import { handleD1Write } from '../src/handlers/d1Write';

function message(statements: readonly SqlWriteStatement[]): D1WriteMessage {
  return {
    type: 'd1_write',
    command: {
      operationId: 'operation-1',
      entityId: 'entity-1',
      actorKey: 'account-1',
      kind: 'insert',
      shard: {
        family: 'POSTS',
        cohort: 0,
        epoch: 1,
        ordinal: 1,
        binding: 'DB_POSTS_C000_E001',
        state: 'active',
      },
      payload: {
        commandType: 'sql_batch',
        statements,
        postCommitMessages: [
          { binding: 'QUEUE_INTERNAL', body: { type: 'timeline_fanout' } },
          { binding: 'QUEUE_FEDERATION', body: { type: 'deliver_activity_fanout' } },
        ],
      },
      acceptedAt: '2026-07-22T00:00:00.000Z',
    },
  };
}

beforeEach(() => {
  mocks.prepare.mockReset();
  mocks.metaPrepare.mockReset().mockImplementation(() => ({
    bind: () => ({ first: async () => ({ state: 'active' }) }),
  }));
  mocks.batch.mockReset().mockResolvedValue([]);
  mocks.claimWriteOperation.mockReset().mockResolvedValue('claimed');
  mocks.updateWriteOperation.mockReset().mockResolvedValue(undefined);
  mocks.internalSend.mockReset().mockResolvedValue(undefined);
  mocks.federationSend.mockReset().mockResolvedValue(undefined);
  mocks.prepare.mockImplementation((sql: string) => ({
    bind: (...params: unknown[]) => ({
      sql,
      params,
      all: async () => ({ results: [] }),
    }),
  }));
  Object.assign(mocks.env, {
    DB_META_C000: { prepare: mocks.metaPrepare },
    DB_POSTS_C000_E001: { prepare: mocks.prepare, batch: mocks.batch },
    INTERNAL_CONNECTION_MAIN: {
      claimWriteOperation: mocks.claimWriteOperation,
      updateWriteOperation: mocks.updateWriteOperation,
    },
    QUEUE_INTERNAL: { send: mocks.internalSend },
    QUEUE_FEDERATION: { send: mocks.federationSend },
  });
});

describe('D1 write consumer', () => {
  it('keeps a large operation in one atomic batch and persists its outbox before commit', async () => {
    const statements = Array.from({ length: 101 }, (_, index) => ({
      sql: `INSERT ${index}`,
      params: [index],
    }));

    await handleD1Write(message(statements));

    expect(mocks.claimWriteOperation).toHaveBeenCalledWith({
      actorKey: 'account-1',
      operationId: 'operation-1',
      leaseMs: 60_000,
    });
    expect(mocks.batch).toHaveBeenCalledTimes(1);
    expect(mocks.batch.mock.calls[0][0]).toHaveLength(104);
    expect(mocks.internalSend).not.toHaveBeenCalled();
    expect(mocks.federationSend).not.toHaveBeenCalled();
    expect(mocks.updateWriteOperation).toHaveBeenLastCalledWith({
      actorKey: 'account-1',
      operationId: 'operation-1',
      state: 'committed',
    });
  });

  it('does not mutate a terminal operation', async () => {
    mocks.claimWriteOperation.mockResolvedValue('terminal');

    await handleD1Write(message([{ sql: 'INSERT 1', params: [] }]));

    expect(mocks.batch).not.toHaveBeenCalled();
    expect(mocks.updateWriteOperation).not.toHaveBeenCalled();
  });

  it('throws for a concurrently leased operation so the Queue message is retried', async () => {
    mocks.claimWriteOperation.mockResolvedValue('busy');

    await expect(handleD1Write(message([{ sql: 'INSERT 1', params: [] }]))).rejects.toThrow('active apply lease');
    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it('rejects a statement beyond the D1 parameter limit and returns it to queued state', async () => {
    const oversized = { sql: 'INSERT oversized', params: Array.from({ length: 101 }, () => 1) };

    await expect(handleD1Write(message([oversized]))).rejects.toThrow('exceeds 100 bound parameters');
    expect(mocks.updateWriteOperation).toHaveBeenLastCalledWith(expect.objectContaining({
      actorKey: 'account-1',
      operationId: 'operation-1',
      state: 'queued',
    }));
  });
});
