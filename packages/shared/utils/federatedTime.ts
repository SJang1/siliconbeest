export interface FederatedTime {
	readonly publishedAtRaw: string | null;
	readonly publishedAtMs: number | null;
	readonly receivedAtMs: number;
	readonly sortAtMs: number;
	readonly correctedFutureTimestamp: boolean;
}

export const FEDERATED_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function normalizeFederatedTime(
	published: unknown,
	receivedAtMs = Date.now(),
	futureSkewMs = FEDERATED_FUTURE_SKEW_MS,
): FederatedTime {
	if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs < 0) {
		throw new RangeError('receivedAtMs must be a non-negative safe integer');
	}
	const publishedAtRaw = typeof published === 'string' ? published : null;
	const parsed = publishedAtRaw === null ? Number.NaN : Date.parse(publishedAtRaw);
	const publishedAtMs = Number.isFinite(parsed) ? parsed : null;
	const correctedFutureTimestamp = publishedAtMs !== null
		&& publishedAtMs > receivedAtMs + futureSkewMs;
	return {
		publishedAtRaw,
		publishedAtMs,
		receivedAtMs,
		sortAtMs: publishedAtMs === null || correctedFutureTimestamp ? receivedAtMs : publishedAtMs,
		correctedFutureTimestamp,
	};
}
