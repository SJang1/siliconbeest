/* oxlint-disable fp/no-loop-statements, fp/no-let, fp/no-promise-reject, fp/no-throw-statements, fp/no-try-statements */

import { env } from 'cloudflare:workers';
import type {
  RealtimeFeedCursor,
  RealtimeFeedEntry,
  RealtimeFeedPage,
} from '../../../../packages/shared/types/realtimeFeed';
import type { ShardRef } from '../../../../packages/shared/types/sharding';
import { GENERATED_D1_SHARD_ROUTES } from '../../../../packages/shared/generated/d1-shard-routes';
import { getAccountStorage, resolveShardDatabase } from './sharding';

const PUBLIC_PARTITIONS = 4;
const MAX_PARALLEL_D1_READS = 6;
const LEGACY_SEARCH_FEED: ShardRef = {
  family: 'SEARCH_FEED', cohort: 0, epoch: 0, ordinal: 0,
  binding: 'DB_META_C000', state: 'legacy',
};

type SearchFeedRow = {
  entity_id: string;
  source_ordinal: number;
  sort_at_ms: number;
  source_version: number;
  snapshot_json: string;
  tombstoned_at: string | null;
};

function partitionsFor(feedKey: string): number {
  return feedKey.startsWith('home:') ? 1 : PUBLIC_PARTITIONS;
}

function entityPartition(entityId: string, partitions: number): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < entityId.length; index += 1) {
    hash ^= entityId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % partitions;
}

function stub(feedKey: string, partition: number) {
  const namespace = env.REALTIME_FEED_DO;
  if (!namespace) throw new Error('Real-time feed Durable Object binding is unavailable');
  return namespace.getByName(`feed:${feedKey}:partition:${partition}`);
}

function tupleBeforeSql(before: RealtimeFeedCursor | null): {
  readonly sql: string;
  readonly bindings: readonly (string | number)[];
} {
  if (!before) return { sql: '', bindings: [] };
  return {
    sql: 'AND (sort_at_ms < ? OR (sort_at_ms = ? AND entity_id < ?))',
    bindings: [before.sortAtMs, before.sortAtMs, before.entityId],
  };
}

async function cohortForFeed(feedKey: string): Promise<number> {
  if (!feedKey.startsWith('home:')) return 0;
  const accountId = feedKey.slice('home:'.length);
  if (!accountId) throw new Error('Home feed key is missing an account ID');
  return (await getAccountStorage(accountId)).cohort;
}

export function readableSearchFeedShards(cohort: number): readonly ShardRef[] {
  const generated = GENERATED_D1_SHARD_ROUTES
    .filter((route) => route.family === 'SEARCH_FEED'
      && route.cohort === cohort && route.state !== 'unavailable')
    .map((route) => ({ ...route }));
  return cohort === 0 ? [LEGACY_SEARCH_FEED, ...generated] : generated;
}

async function readShardPage(
  shard: ShardRef,
  feedKey: string,
  before: RealtimeFeedCursor | null,
  limit: number,
): Promise<readonly RealtimeFeedEntry[]> {
  const table = shard.ordinal === 0 ? 'search_feed_entries' : 'feed_entries';
  const cursor = tupleBeforeSql(before);
  // This is the correctness fallback for a missing/stale DO index. Anchor the
  // first read at the primary so replica lag cannot make a committed entry
  // disappear from the recovery page.
  const session = resolveShardDatabase(shard).withSession('first-primary');
  const result = await session.prepare(
    `SELECT entity_id, source_ordinal, sort_at_ms, source_version,
            entity_summary_json AS snapshot_json, tombstoned_at
     FROM ${table}
     WHERE feed_key = ? ${cursor.sql}
     ORDER BY sort_at_ms DESC, entity_id DESC LIMIT ?`,
  ).bind(feedKey, ...cursor.bindings, Math.min(Math.max(limit * 4, limit), 100)).all<SearchFeedRow>();
  return result.results.map((row) => ({
    feedKey,
    entityId: row.entity_id,
    sourceOrdinal: row.source_ordinal,
    sortAtMs: row.sort_at_ms,
    sourceVersion: row.source_version,
    ...(row.snapshot_json ? { snapshotJson: row.snapshot_json } : {}),
    ...(row.tombstoned_at ? { tombstoned: true } : {}),
  }));
}

export function mergeRealtimeFeedEntries(
  pages: readonly (readonly RealtimeFeedEntry[])[],
  limit: number,
): readonly RealtimeFeedEntry[] {
  const newest = new Map<string, RealtimeFeedEntry>();
  for (const entry of pages.flat()) {
    const previous = newest.get(entry.entityId);
    if (!previous || entry.sourceVersion > previous.sourceVersion
      || (entry.sourceVersion === previous.sourceVersion && entry.tombstoned)) {
      newest.set(entry.entityId, entry);
    }
  }
  return [...newest.values()]
    .filter((entry) => !entry.tombstoned)
    .sort((left, right) => right.sortAtMs - left.sortAtMs
      || right.entityId.localeCompare(left.entityId))
    .slice(0, Math.min(Math.max(limit, 1), 100));
}

export async function readSearchFeedFromD1(
  feedKey: string,
  before: RealtimeFeedCursor | null,
  limit: number,
): Promise<RealtimeFeedPage> {
  const shards = readableSearchFeedShards(await cohortForFeed(feedKey));
  if (shards.length > MAX_PARALLEL_D1_READS) {
    console.warn('[realtime feed] D1 fallback requires multiple waves', {
      feedKey,
      shardCount: shards.length,
      waveCount: Math.ceil(shards.length / MAX_PARALLEL_D1_READS),
    });
  }
  const pages: Array<readonly RealtimeFeedEntry[]> = [];
  for (let offset = 0; offset < shards.length; offset += MAX_PARALLEL_D1_READS) {
    const wave = shards.slice(offset, offset + MAX_PARALLEL_D1_READS);
    pages.push(...await Promise.all(wave.map((shard) => readShardPage(
      shard, feedKey, before, limit,
    ))));
  }
  return { entries: mergeRealtimeFeedEntries(pages, limit) };
}

export async function projectRealtimeFeedToDurableObject(entry: RealtimeFeedEntry): Promise<void> {
  const partitions = partitionsFor(entry.feedKey);
  await stub(entry.feedKey, entityPartition(entry.entityId, partitions)).project(entry);
}

export async function projectRealtimeFeed(entry: RealtimeFeedEntry): Promise<void> {
  if (env.REALTIME_FEED_DO) {
    await projectRealtimeFeedToDurableObject(entry);
    return;
  }
  if (!env.INTERNAL_CONNECTION_MAIN) throw new Error('Real-time feed projection binding is unavailable');
  await env.INTERNAL_CONNECTION_MAIN.projectRealtimeFeed(entry);
}

export async function readRealtimeFeed(
  feedKey: string,
  before: RealtimeFeedCursor | null,
  limit: number,
): Promise<RealtimeFeedPage> {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  let durableEntries: readonly RealtimeFeedEntry[] = [];
  try {
    const partitionCount = partitionsFor(feedKey);
    const pages = await Promise.all(Array.from({ length: partitionCount }, (_, partition) =>
      stub(feedKey, partition).page(feedKey, before, safeLimit),
    ));
    durableEntries = mergeRealtimeFeedEntries(pages.map((page) => page.entries), safeLimit);
  } catch (error) {
    console.warn('[realtime feed] Durable Object read failed; falling back to D1', error);
  }
  if (durableEntries.length >= safeLimit) return { entries: durableEntries };

  const durablePage = durableEntries;
  const d1Page = await readSearchFeedFromD1(feedKey, before, safeLimit);
  return { entries: mergeRealtimeFeedEntries([durablePage, d1Page.entries], safeLimit) };
}
