/**
 * ULID (Universally Unique Lexicographically Sortable Identifier) Utilities
 *
 * Zero-dependency ULID generation using crypto.getRandomValues (available in
 * Cloudflare Workers, Node 19+, and all modern browsers).
 */

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BIGINT_FIVE = BigInt(5);
const BIGINT_EIGHT = BigInt(8);
const BIGINT_31 = BigInt(31);
const BIGINT_56 = BigInt(56);
const BIGINT_76 = BigInt(76);
const BIGINT_0X_F = BigInt(0xf);
const BIGINT_0X_FFFFF = BigInt(0xfffff);

export const SHARD_ULID_FORMAT_VERSION = 1;
export const MAX_PHYSICAL_SHARD_ORDINAL = 0xfffff;

export interface GenerateUlidOptions {
	/** Globally unique physical D1 shard ordinal (20 bits). */
	readonly shardOrdinal?: number;
	/** Reserved for future ID layouts. Version 0 belongs to pre-cutover IDs. */
	readonly formatVersion?: number;
	/** Injectable clock for deterministic tests. */
	readonly timestampMs?: number;
}

export interface DecodedShardUlid {
	readonly timestampMs: number;
	readonly formatVersion: number;
	readonly shardOrdinal: number;
	readonly legacy: boolean;
}

function encodeBase32(value: bigint, length: number): string {
	const chars = new Array<string>(length);
	let remaining = value;
	for (let index = length - 1; index >= 0; index--) {
		chars[index] = CROCKFORD_BASE32[Number(remaining & BIGINT_31)];
		remaining >>= BIGINT_FIVE;
	}
	return chars.join('');
}

function decodeBase32(value: string): bigint {
	let decoded = BigInt(0);
	for (const character of value.toUpperCase()) {
		const digit = CROCKFORD_BASE32.indexOf(character);
		if (digit < 0) throw new Error(`Invalid ULID character: ${character}`);
		decoded = (decoded << BIGINT_FIVE) | BigInt(digit);
	}
	return decoded;
}

/**
 * Generate a new ULID.
 *
 * Format: 10 chars timestamp (48-bit ms since epoch) + 16 chars randomness (80-bit)
 * Crockford Base32 encoded, always 26 characters.
 */
export function generateUlid(options: GenerateUlidOptions = {}): string {
	const timestampMs = options.timestampMs ?? Date.now();
	const formatVersion = options.formatVersion ?? SHARD_ULID_FORMAT_VERSION;
	const shardOrdinal = options.shardOrdinal ?? 0;
	if (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || timestampMs > 0xffffffffffff) {
		throw new RangeError('ULID timestamp must fit in 48 bits');
	}
	if (!Number.isInteger(formatVersion) || formatVersion < 1 || formatVersion > 0xf) {
		throw new RangeError('ULID format version must be between 1 and 15');
	}
	if (!Number.isInteger(shardOrdinal) || shardOrdinal < 0 || shardOrdinal > MAX_PHYSICAL_SHARD_ORDINAL) {
		throw new RangeError(`Shard ordinal must be between 0 and ${MAX_PHYSICAL_SHARD_ORDINAL}`);
	}

	const timePart = encodeBase32(BigInt(timestampMs), 10);
	const randomBytes = new Uint8Array(10);
	crypto.getRandomValues(randomBytes);
	// The first 24 randomness bits are deterministic routing metadata.
	randomBytes[0] = (formatVersion << 4) | ((shardOrdinal >>> 16) & 0x0f);
	randomBytes[1] = (shardOrdinal >>> 8) & 0xff;
	randomBytes[2] = shardOrdinal & 0xff;

	let randomness = BigInt(0);
	for (const byte of randomBytes) {
		randomness = (randomness << BIGINT_EIGHT) | BigInt(byte);
	}
	return timePart + encodeBase32(randomness, 16);
}

/**
 * Validate whether a string is a valid ULID.
 * A valid ULID is exactly 26 characters of Crockford Base32 (uppercase).
 */
export function isValidUlid(id: string): boolean {
	if (typeof id !== 'string' || id.length !== 26) {
		return false;
	}
	const crockfordBase32 = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
	return crockfordBase32.test(id.toUpperCase());
}

/**
 * Extract the timestamp from a ULID and return it as a Date object.
 */
export function ulidToDate(id: string): Date {
	if (!isValidUlid(id)) throw new Error('Invalid ULID');
	return new Date(Number(decodeBase32(id.slice(0, 10))));
}

/**
 * Decode an entity ID without guessing whether pre-cutover randomness happens
 * to look like a versioned header. All IDs before the immutable cutover are
 * format 0 on physical shard ordinal 0.
 */
export function decodeShardUlid(id: string, cutoverTimestampMs: number): DecodedShardUlid {
	if (!isValidUlid(id)) throw new Error('Invalid ULID');
	const timestampMs = Number(decodeBase32(id.slice(0, 10)));
	if (timestampMs < cutoverTimestampMs) {
		return { timestampMs, formatVersion: 0, shardOrdinal: 0, legacy: true };
	}

	const randomness = decodeBase32(id.slice(10));
	const formatVersion = Number((randomness >> BIGINT_76) & BIGINT_0X_F);
	const shardOrdinal = Number((randomness >> BIGINT_56) & BIGINT_0X_FFFFF);
	if (formatVersion === 0) {
		throw new Error('Post-cutover ULID is missing a format version');
	}
	return { timestampMs, formatVersion, shardOrdinal, legacy: false };
}

/** Lowest lexicographic ULID value for the supplied millisecond. */
export function ulidLowerBound(timestampMs: number): string {
	return encodeBase32(BigInt(timestampMs), 10) + '0000000000000000';
}
