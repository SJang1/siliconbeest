export interface StreamingTopology {
	readonly branchFactor: number;
	readonly depth: number;
	readonly leafCount: number;
	readonly publicLeafMaxSockets: number;
	readonly userMaxSockets: number;
	readonly socketMaxBufferedBytes: number;
	readonly eventMaxBytes: number;
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function resolveStreamingTopology(source: {
	readonly STREAM_PUBLIC_BRANCH_FACTOR?: string;
	readonly STREAM_PUBLIC_TREE_DEPTH?: string;
	readonly STREAM_PUBLIC_LEAF_MAX_SOCKETS?: string;
	readonly STREAM_USER_MAX_SOCKETS?: string;
	readonly STREAM_SOCKET_MAX_BUFFERED_BYTES?: string;
	readonly STREAM_EVENT_MAX_BYTES?: string;
}): StreamingTopology {
	// Five stays below the six simultaneous outgoing connection limit while
	// producing 125 public leaves at depth three.
	const branchFactor = boundedInteger(source.STREAM_PUBLIC_BRANCH_FACTOR, 5, 2, 5);
	const depth = boundedInteger(source.STREAM_PUBLIC_TREE_DEPTH, 3, 2, 4);
	return {
		branchFactor,
		depth,
		leafCount: branchFactor ** depth,
		publicLeafMaxSockets: boundedInteger(source.STREAM_PUBLIC_LEAF_MAX_SOCKETS, 400, 50, 1_000),
		userMaxSockets: boundedInteger(source.STREAM_USER_MAX_SOCKETS, 32, 4, 256),
		socketMaxBufferedBytes: boundedInteger(source.STREAM_SOCKET_MAX_BUFFERED_BYTES, 262_144, 65_536, 4_194_304),
		eventMaxBytes: boundedInteger(source.STREAM_EVENT_MAX_BYTES, 98_304, 16_384, 131_072),
	};
}

export function stableStreamingLeaf(key: string, leafCount: number): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < key.length; index += 1) {
		hash ^= key.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash % leafCount;
}

export function streamingEventBytes(event: { readonly event: string; readonly payload: string; readonly stream?: readonly string[] }): number {
	return new TextEncoder().encode(JSON.stringify(event)).byteLength;
}
