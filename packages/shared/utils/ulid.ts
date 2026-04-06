/**
 * ULID (Universally Unique Lexicographically Sortable Identifier) Utilities
 *
 * Self-contained implementation that works in Cloudflare Workers
 * without external dependencies. Uses Web Crypto API for randomness.
 */

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generate a new ULID.
 *
 * Format: 10 chars timestamp (48-bit ms since epoch) + 16 chars randomness (80-bit)
 * Crockford Base32 encoded, always 26 characters.
 */
export function generateUlid(): string {
	const now = Date.now();

	// Encode timestamp (48-bit, 10 chars of Crockford Base32)
	let ts = '';
	let t = now;
	for (let i = 0; i < 10; i++) {
		ts = CROCKFORD_BASE32[t % 32] + ts;
		t = Math.floor(t / 32);
	}

	// Encode randomness (80-bit, 16 chars of Crockford Base32)
	const rand = crypto.getRandomValues(new Uint8Array(10));
	let r = '';
	for (let i = 0; i < 10; i++) {
		// Use two chars per byte (5 bits each, but we only have 8 bits per byte)
		// We need 16 chars from 10 bytes = 80 bits
		r += CROCKFORD_BASE32[rand[i] >> 3]; // upper 5 bits
		if (i < 6) {
			// For first 6 bytes, also use lower bits combined with next byte
			r += CROCKFORD_BASE32[((rand[i] & 0x07) << 2) | (i + 1 < 10 ? rand[i + 1] >> 6 : 0)];
		}
	}
	// Trim to exactly 16 chars
	r = r.slice(0, 16);

	return ts + r;
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
