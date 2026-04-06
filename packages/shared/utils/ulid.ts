/**
 * ULID (Universally Unique Lexicographically Sortable Identifier) Utilities
 *
 * Re-exports from the `ulid` package for ULID generation,
 * with additional validation and timestamp extraction helpers.
 */

import { ulid } from 'ulid';

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generate a new ULID.
 *
 * Format: 10 chars timestamp (48-bit ms since epoch) + 16 chars randomness (80-bit)
 * Crockford Base32 encoded, always 26 characters.
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
	const crockfordBase32 = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
	return crockfordBase32.test(id.toUpperCase());
}

/**
 * Extract the timestamp from a ULID and return it as a Date object.
 */
export function ulidToDate(id: string): Date {
	let time = 0;
	const upper = id.toUpperCase();
	for (let i = 0; i < 10; i++) {
		const idx = CROCKFORD_BASE32.indexOf(upper[i]);
		if (idx === -1) throw new Error(`Invalid ULID character: ${upper[i]}`);
		time = time * 32 + idx;
	}
	return new Date(time);
}
