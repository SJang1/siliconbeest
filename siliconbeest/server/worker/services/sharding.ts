/* oxlint-disable fp/no-promise-reject, fp/no-throw-statements, fp/no-let */

import { env } from 'cloudflare:workers';
import type {
	AcceptingCohort,
  AccountStorage,
  EntityRoute,
  ShardFamily,
  ShardRef,
} from '../../../../packages/shared/types/sharding';
import { decodeShardUlid } from '../utils/ulid';
import { GENERATED_D1_SHARD_ROUTES } from '../../../../packages/shared/generated/d1-shard-routes';

type ShardCatalogRow = {
  family: ShardFamily;
  cohort: number;
  epoch: number;
  ordinal: number;
  binding: string;
  state: ShardRef['state'];
};

function toShardRef(row: ShardCatalogRow): ShardRef {
  return {
    family: row.family,
    cohort: row.cohort,
    epoch: row.epoch,
    ordinal: row.ordinal,
    binding: row.binding,
    state: row.state,
  };
}

export async function getIdFormatCutoverMs(db: D1Database = env.DB_META_C000): Promise<number> {
  const row = await db.prepare(
    "SELECT value FROM storage_config WHERE key = 'id_format_cutover_ms' LIMIT 1",
  ).first<{ value: string }>();
  const value = Number(row?.value);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('D1 shard routing migration has not initialized id_format_cutover_ms');
  }
  return value;
}

export async function getAccountStorage(accountId: string): Promise<AccountStorage> {
  let row = await env.DB_META_C000.prepare(
    'SELECT account_id, cohort FROM account_storage WHERE account_id = ?1 LIMIT 1',
  ).bind(accountId).first<{ account_id: string; cohort: number }>();
  if (!row) {
    const result = await env.DB_META_C000.prepare(
      `INSERT OR IGNORE INTO account_storage (account_id, cohort)
       SELECT ?1, 0 WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ?1)`,
    ).bind(accountId).run();
    if ((result.meta?.changes ?? 0) > 1) {
      throw new Error(`Unexpected cohort assignment result for account ${accountId}`);
    }
    row = await env.DB_META_C000.prepare(
      'SELECT account_id, cohort FROM account_storage WHERE account_id = ?1 LIMIT 1',
    ).bind(accountId).first<{ account_id: string; cohort: number }>();
    if (!row) throw new Error(`No storage cohort can be assigned for account ${accountId}`);
  }
  return { accountId: row.account_id, cohort: row.cohort };
}

export async function getActiveShard(family: ShardFamily, cohort: number): Promise<ShardRef> {
  const row = await env.DB_META_C000.prepare(
    `SELECT family, cohort, epoch, ordinal, binding, state
     FROM shard_catalog
     WHERE family = ?1 AND cohort = ?2 AND state IN ('legacy', 'active')
     ORDER BY epoch DESC
     LIMIT 1`,
  ).bind(family, cohort).first<ShardCatalogRow>();
  if (!row) throw new Error(`No active ${family} shard for cohort ${cohort}`);
  return toShardRef(row);
}

function hashUnitInterval(value: string): number {
	let hash = 2_166_136_261;
	for (const byte of new TextEncoder().encode(value)) {
		hash = Math.imul(hash ^ byte, 16_777_619) >>> 0;
	}
	// Keep the value strictly inside (0, 1] so log() is always finite.
	return (hash + 1) / 4_294_967_297;
}

export function chooseWeightedRendezvousCohort(
	key: string,
	cohorts: readonly AcceptingCohort[],
): AcceptingCohort {
	if (cohorts.length === 0) throw new Error('No META cohort is accepting registrations');
	let selected = cohorts[0];
	let best = Number.POSITIVE_INFINITY;
	for (const cohort of cohorts) {
		if (!Number.isFinite(cohort.weight) || cohort.weight <= 0) continue;
		const score = -Math.log(hashUnitInterval(`${key}:${cohort.cohort}`)) / cohort.weight;
		if (score < best || (score === best && cohort.cohort < selected.cohort)) {
			selected = cohort;
			best = score;
		}
	}
	return selected;
}

export async function getAcceptingCohorts(db: D1Database = env.DB_META_C000): Promise<AcceptingCohort[]> {
	const requiredFamilies: readonly ShardFamily[] = [
		'META', 'POSTS', 'GRAPH', 'INBOX', 'SEARCH_FEED', 'OPS',
	];
	const result = await db.prepare(
		`SELECT c.cohort, c.weight, c.catalog_version
		 FROM accepting_cohorts c
		 WHERE c.accepting = 1
		   AND EXISTS (
		     SELECT 1 FROM cohort_capabilities capability
		     WHERE capability.cohort = c.cohort AND capability.capability = 'registration_v1'
		   )
		   AND NOT EXISTS (
		     SELECT 1 FROM (SELECT column1 AS family FROM (VALUES ${requiredFamilies.map(() => '(?)').join(', ')})) required
		     WHERE NOT EXISTS (
		       SELECT 1 FROM shard_catalog s
		       WHERE s.cohort = c.cohort AND s.family = required.family
		         AND s.state IN ('legacy', 'active')
		     )
		   )
		 ORDER BY c.cohort`,
	).bind(...requiredFamilies).all<{ cohort: number; weight: number; catalog_version: number }>();
	return result.results.map((row) => ({
		cohort: row.cohort,
		weight: row.weight,
		catalogVersion: row.catalog_version,
	}));
}

export async function chooseRegistrationCohort(operationId: string): Promise<AcceptingCohort> {
	return chooseWeightedRendezvousCohort(operationId, await getAcceptingCohorts());
}

export async function locateEntity(entityType: string, entityId: string, family: ShardFamily): Promise<EntityRoute> {
  const cutoverTimestampMs = await getIdFormatCutoverMs();
  const decoded = decodeShardUlid(entityId, cutoverTimestampMs);
  if (decoded.legacy) {
    const row = await env.DB_META_C000.prepare(
      `SELECT entity_type, entity_id, family, cohort, epoch, ordinal, format_version
       FROM entity_routes WHERE entity_type = ?1 AND entity_id = ?2 LIMIT 1`,
    ).bind(entityType, entityId).first<{
      entity_type: string;
      entity_id: string;
      family: ShardFamily;
      cohort: number;
      epoch: number;
      ordinal: number;
      format_version: number;
    }>();
    if (!row) throw new Error(`No legacy route registered for ${entityType} ${entityId}`);
    return {
      entityType: row.entity_type,
      entityId: row.entity_id,
      family: row.family,
      cohort: row.cohort,
      epoch: row.epoch,
      ordinal: row.ordinal,
      formatVersion: row.format_version,
    };
  }

  const shard = await getShardByOrdinal(decoded.shardOrdinal, family);
  return {
    entityType,
    entityId,
    family: shard.family,
    cohort: shard.cohort,
    epoch: shard.epoch,
    ordinal: shard.ordinal,
    formatVersion: decoded.formatVersion,
  };
}

export async function getShardByOrdinal(ordinal: number, family: ShardFamily): Promise<ShardRef> {
  const generated = GENERATED_D1_SHARD_ROUTES.find((candidate) => (
    candidate.ordinal === ordinal && candidate.family === family
  ));
  if (generated) return toShardRef(generated);
  if (ordinal > 0) {
    throw new Error(`Ordinal ${ordinal} is absent from the deployed D1 binding manifest`);
  }
  const row = await env.DB_META_C000.prepare(
    `SELECT family, cohort, epoch, ordinal, binding, state
     FROM shard_catalog
     WHERE ordinal = ?1 AND family = ?2
     ORDER BY epoch DESC LIMIT 1`,
  ).bind(ordinal, family).first<ShardCatalogRow>();
  if (!row) throw new Error(`Unknown physical shard ordinal ${ordinal} for ${family}`);
  if (row.state === 'unavailable') throw new Error(`Shard ordinal ${ordinal} is unavailable`);
  return toShardRef(row);
}

function isD1Database(value: unknown): value is D1Database {
  if (!value || typeof value !== 'object') return false;
  return typeof Reflect.get(value, 'prepare') === 'function' && typeof Reflect.get(value, 'batch') === 'function';
}

export function resolveShardDatabase(shard: ShardRef): D1Database {
  const binding: unknown = Reflect.get(env, shard.binding);
  if (!isD1Database(binding)) {
    throw new Error(`D1 binding ${shard.binding} is unavailable for shard ordinal ${shard.ordinal}`);
  }
  return binding;
}
