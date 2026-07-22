import type { ShardRef } from './sharding';

export type WriteOperationState = 'accepted' | 'queued' | 'applying' | 'committed' | 'failed' | 'attention_required';
export type WriteOperationKind = 'insert' | 'update';

export interface SqlWriteStatement {
	readonly sql: string;
	readonly params: readonly (string | number | null)[];
}

export interface SqlBatchWritePayload {
	readonly commandType: 'sql_batch';
	/** Temporary legacy adapter. New shard writers must use a versioned domain command. */
	readonly schemaVersion?: 1;
	readonly statements: readonly SqlWriteStatement[];
	/** Optional representation returned while the D1 write is pending. */
	readonly pendingResponse?: Readonly<Record<string, unknown>>;
	readonly postCommitMessages?: readonly {
		readonly binding: 'QUEUE_INTERNAL' | 'QUEUE_FEDERATION';
		readonly body: Readonly<Record<string, unknown>>;
	}[];
}

export interface VersionedDomainWritePayload {
	readonly commandType:
		| 'CreateAccount'
		| 'CreatePost'
		| 'UpdatePost'
		| 'ApplyGraphEdge'
		| 'ProjectFeedEntry';
	readonly schemaVersion: 1;
	readonly aggregateVersion: number;
	readonly body: Readonly<Record<string, unknown>>;
}

export type WritePayload = SqlBatchWritePayload | VersionedDomainWritePayload;

export interface WriteCommand {
	readonly operationId: string;
	readonly entityId: string;
	readonly actorKey: string;
	readonly kind: WriteOperationKind;
	readonly shard: ShardRef;
	readonly payload: WritePayload;
	readonly acceptedAt: string;
	readonly aggregateVersion?: number;
	/** Growth is rejected on sealed shards; reclaim is reserved for delete/compaction commands. */
	readonly capacityEffect?: 'growth' | 'neutral' | 'reclaim';
}

export interface WriteReceipt {
	readonly operationId: string;
	readonly entityId: string;
	readonly state: 'pending';
}

export interface WriteOperation {
	readonly operationId: string;
	readonly entityId: string;
	readonly state: WriteOperationState;
	readonly attempts: number;
	readonly acceptedAt: string;
	readonly updatedAt: string;
	readonly error: string | null;
}

export interface D1WriteMessage {
	readonly type: 'd1_write';
	readonly command: WriteCommand;
}

export interface ShardOutboxMessage {
	readonly type: 'shard_outbox';
	readonly eventId: string;
	readonly operationId: string;
	readonly binding: 'QUEUE_INTERNAL' | 'QUEUE_FEDERATION';
	readonly body: Readonly<Record<string, unknown>>;
}

export interface WriteProgress {
	readonly actorKey: string;
	readonly operationId: string;
	readonly state: 'queued' | 'applying' | 'committed' | 'failed';
	readonly error?: string;
}

export interface WriteClaim {
	readonly actorKey: string;
	readonly operationId: string;
	readonly leaseMs: number;
}

export type WriteClaimResult = 'claimed' | 'busy' | 'terminal' | 'missing';
