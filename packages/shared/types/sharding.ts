export const SHARD_FAMILIES = [
	'META',
	'POSTS',
	'GRAPH',
	'INBOX',
	'REMOTE_ACTORS',
	'REMOTE_POSTS',
	'SEARCH_FEED',
	'OPS',
] as const;

export type ShardFamily = (typeof SHARD_FAMILIES)[number];

export const SHARD_LIFECYCLE_STATES = [
	'legacy',
	'precreated',
	'active',
	'draining',
	'sealed',
	'unavailable',
] as const;

export type ShardLifecycleState = (typeof SHARD_LIFECYCLE_STATES)[number];

export interface ShardRef {
	readonly family: ShardFamily;
	readonly cohort: number;
	readonly epoch: number;
	readonly ordinal: number;
	readonly binding: string;
	readonly state: ShardLifecycleState;
	readonly sharedPhysicalDatabase?: boolean;
}

export interface AcceptingCohort {
	readonly cohort: number;
	readonly weight: number;
	readonly catalogVersion: number;
}

export interface AccountStorage {
	readonly accountId: string;
	readonly cohort: number;
}

export interface EntityRoute {
	readonly entityType: string;
	readonly entityId: string;
	readonly family: ShardFamily;
	readonly cohort: number;
	readonly epoch: number;
	readonly ordinal: number;
	readonly formatVersion: number;
}

export interface ShardCapacityLimits {
	readonly maxBytes: number;
	readonly precreateRatio: number;
	readonly activateRatio: number;
	readonly hardStopRatio: number;
}

export type ShardLimits = Readonly<Record<ShardFamily, ShardCapacityLimits>>;

export function isShardFamily(value: unknown): value is ShardFamily {
	return typeof value === 'string' && (SHARD_FAMILIES as readonly string[]).includes(value);
}

export function assertValidShardLimits(value: unknown): asserts value is ShardLimits {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('D1 shard limits must be a JSON object');
	}
	const record = value as Record<string, unknown>;
	for (const family of SHARD_FAMILIES) {
		const limits = record[family];
		if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
			throw new Error(`Missing D1 shard limits for ${family}`);
		}
		const fields = limits as Record<string, unknown>;
		const maxBytes = fields.maxBytes;
		const precreate = fields.precreateRatio;
		const activate = fields.activateRatio;
		const hardStop = fields.hardStopRatio;
		if (
			typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 10_000_000_000
			|| typeof precreate !== 'number' || !Number.isFinite(precreate) || precreate <= 0
			|| typeof activate !== 'number' || !Number.isFinite(activate)
			|| typeof hardStop !== 'number' || !Number.isFinite(hardStop)
			|| precreate > activate || activate >= hardStop || hardStop >= 1
		) {
			throw new Error(`Invalid D1 shard limits for ${family}`);
		}
	}
}
