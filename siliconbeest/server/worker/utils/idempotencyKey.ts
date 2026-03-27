/**
 * Idempotency key utilities for preventing duplicate request processing.
 * Uses Cloudflare Workers KV for storage.
 */

const DEFAULT_TTL_SECONDS = 3600; // 1 hour
const KEY_PREFIX = 'idempotency:';

/**
 * Check if an idempotency key exists and return the cached response if it does.
 *
 * @param kv - Cloudflare KV namespace binding.
 * @param key - The idempotency key from the request header.
 * @returns The cached response string if the key exists, or null if not found.
 */
export async function checkIdempotencyKey(kv: KVNamespace, key: string): Promise<string | null> {
	const stored = await kv.get(`${KEY_PREFIX}${key}`);
	return stored;
}

/**
 * Store a response for an idempotency key.
 *
 * @param kv - Cloudflare KV namespace binding.
 * @param key - The idempotency key from the request header.
 * @param response - The serialized response to cache.
 * @param ttlSeconds - Time-to-live in seconds (default: 1 hour).
 */
export async function setIdempotencyKey(
	kv: KVNamespace,
	key: string,
	response: string,
	ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<void> {
	await kv.put(`${KEY_PREFIX}${key}`, response, {
		expirationTtl: ttlSeconds,
	});
}
