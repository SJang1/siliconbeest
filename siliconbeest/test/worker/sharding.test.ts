import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  assertValidShardLimits,
  SHARD_FAMILIES,
} from '../../../packages/shared/types/sharding';
import { getActiveShard } from '../../server/worker/services/sharding';
import { applyMigration } from './helpers';

beforeAll(async () => {
  await applyMigration();
});

describe('D1 shard limits', () => {
  it('accepts independent limits for every service family', () => {
    const limits = Object.fromEntries(SHARD_FAMILIES.map((family, index) => [
      family,
      { maxBytes: 10_000_000_000, precreateRatio: 0.4, activateRatio: 0.5 + index * 0.01, hardStopRatio: 0.9 },
    ]));

    expect(() => assertValidShardLimits(limits)).not.toThrow();
  });

  it('fails closed when a family is missing', () => {
    expect(() => assertValidShardLimits({
      META: { maxBytes: 10_000_000_000, precreateRatio: 0.4, activateRatio: 0.5, hardStopRatio: 0.85 },
    })).toThrow('Missing D1 shard limits');
  });

  it('rejects an unsafe threshold ordering', () => {
    const limits = Object.fromEntries(SHARD_FAMILIES.map((family) => [
      family,
      { maxBytes: 10_000_000_000, precreateRatio: 0.9, activateRatio: 0.8, hardStopRatio: 0.97 },
    ]));

    expect(() => assertValidShardLimits(limits)).toThrow('Invalid D1 shard limits');
  });
});

describe('D1 shard write gate', () => {
  it('records a verified legacy-route checkpoint', async () => {
    const checkpoint = await env.DB_META_C000.prepare(
      `SELECT source_rows, routed_rows, duplicate_rows, missing_rows, completed_at
       FROM storage_migration_checkpoints WHERE migration = '0054_entity_routes_v0'`,
    ).first<{
      source_rows: number;
      routed_rows: number;
      duplicate_rows: number;
      missing_rows: number;
      completed_at: string | null;
    }>();
    expect(checkpoint).toMatchObject({
      source_rows: checkpoint?.routed_rows,
      duplicate_rows: 0,
      missing_rows: 0,
    });
    expect(checkpoint?.completed_at).not.toBeNull();
  });

  it('does not route new writes to a sealed shard', async () => {
    await env.DB_META_C000.prepare(
      "UPDATE shard_catalog SET state = 'sealed' WHERE family = 'POSTS' AND cohort = 0 AND epoch = 0",
    ).run();
    try {
      await expect(getActiveShard('POSTS', 0)).rejects.toThrow('No active POSTS shard');
    } finally {
      await env.DB_META_C000.prepare(
        "UPDATE shard_catalog SET state = 'legacy' WHERE family = 'POSTS' AND cohort = 0 AND epoch = 0",
      ).run();
    }
  });
});
