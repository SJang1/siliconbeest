import { ulid, decodeTime, encodeTime } from 'ulid';

/**
 * Generate a new ULID (Universally Unique Lexicographically Sortable Identifier).
 */
export function generateUlid(): string {
	return ulid();
}

/**
 * Validate whether a string is a valid ULID.
 * A valid ULID is exactly 26 characters of Crockford Base32 (uppercase).
 */
export function isValidUlid(id: string): boolean {
	if (typeof id !== 'string' || id.length !== 26) {
		return false;
	}
	// Crockford Base32 alphabet (uppercase)
	const crockfordBase32 = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
	return crockfordBase32.test(id.toUpperCase());
}

/**
 * Extract the timestamp from a ULID and return it as a Date object.
 */
export function ulidToDate(id: string): Date {
	const timestamp = decodeTime(id);
	return new Date(timestamp);
}

/**
 * Lowest possible ULID for a given timestamp (in ms).
 * ULIDs sort lexicographically by creation time, so `id >= ulidLowerBound(t)`
 * selects rows created at or after `t` via the primary-key index — useful on
 * tables that have no created_at index (e.g. media_attachments).
 */
export function ulidLowerBound(timestampMs: number): string {
	return encodeTime(timestampMs, 10) + '0000000000000000';
}
