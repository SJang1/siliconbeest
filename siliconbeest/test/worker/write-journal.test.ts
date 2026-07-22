import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { WriteCommand } from '../../../packages/shared/types/write';

function command(operationId: string): WriteCommand {
  return {
    operationId,
    entityId: '01HF7YAT001000000000000000',
    actorKey: 'account-write-journal-test',
    kind: 'insert',
    shard: {
      family: 'POSTS',
      cohort: 0,
      epoch: 0,
      ordinal: 0,
      binding: 'DB_META_C000',
      state: 'legacy',
    },
    payload: {
      commandType: 'sql_batch',
      statements: [{ sql: 'SELECT 1', params: [] }],
      pendingResponse: { id: '01HF7YAT001000000000000000', write_state: 'pending' },
    },
    acceptedAt: new Date().toISOString(),
  };
}

describe('WriteJournalDO', () => {
  it('persists before returning a queued receipt and deduplicates operation IDs', async () => {
    const stub = env.WRITE_JOURNAL_DO.getByName('account-write-journal-test');
    const write = command('operation-write-journal-test');

    const first = await stub.accept(write);
    const second = await stub.accept(write);
    const stored = await stub.getOperation(write.operationId);

    expect(first).toEqual(second);
    expect(first).toEqual({
      operationId: write.operationId,
      entityId: write.entityId,
      state: 'pending',
    });
    expect(stored?.state).toBe('queued');
    expect(stored?.attempts).toBe(1);
  });

  it('returns an overlay while the entity is pending and removes it after commit', async () => {
    const stub = env.WRITE_JOURNAL_DO.getByName('account-write-journal-overlay-test');
    const write = { ...command('operation-write-journal-overlay-test'), actorKey: 'account-write-journal-overlay-test' };
    await stub.accept(write);

    expect(await stub.getPendingEntity(write.entityId)).toEqual({
      id: write.entityId,
      write_state: 'pending',
    });

    await stub.update({
      actorKey: write.actorKey,
      operationId: write.operationId,
      state: 'committed',
    });
    expect(await stub.getPendingEntity(write.entityId)).toBeNull();
  });

  it('claims once per lease and never reopens a terminal operation', async () => {
    const stub = env.WRITE_JOURNAL_DO.getByName('account-write-journal-claim-test');
    const write = { ...command('operation-write-journal-claim-test'), actorKey: 'account-write-journal-claim-test' };
    await stub.accept(write);

    expect(await stub.claim(write.operationId, 60_000)).toBe('claimed');
    expect(await stub.claim(write.operationId, 60_000)).toBe('busy');
    await stub.update({ actorKey: write.actorKey, operationId: write.operationId, state: 'committed' });
    expect(await stub.claim(write.operationId, 60_000)).toBe('terminal');

    await stub.update({ actorKey: write.actorKey, operationId: write.operationId, state: 'queued' });
    expect((await stub.getOperation(write.operationId))?.state).toBe('committed');
  });
});
