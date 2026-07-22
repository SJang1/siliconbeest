export interface RealtimeFeedEntry {
	readonly feedKey: string;
	readonly entityId: string;
	readonly sourceOrdinal: number;
	readonly sortAtMs: number;
	readonly sourceVersion: number;
	readonly snapshotJson?: string;
	readonly tombstoned?: boolean;
}

export interface RealtimeFeedCursor {
	readonly sortAtMs: number;
	readonly entityId: string;
}

export interface RealtimeFeedPage {
	readonly entries: readonly RealtimeFeedEntry[];
}
