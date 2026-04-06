/**
 * ULID (Universally Unique Lexicographically Sortable Identifier) Utilities
 *
 * Zero-dependency ULID generation using crypto.getRandomValues (available in
 * Cloudflare Workers, Node 19+, and all modern browsers).
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
	// Encode 48-bit timestamp as 10 Crockford Base32 characters (most significant first)
	let ts = now;
	const timePart = new Array(10);
	for (let i = 9; i >= 0; i--) {
		timePart[i] = CROCKFORD_BASE32[ts & 0x1f]; // ts % 32
		ts = Math.floor(ts / 32);
	}

	// Encode 80 bits of randomness as 16 Crockford Base32 characters
	const randomBytes = new Uint8Array(10);
	crypto.getRandomValues(randomBytes);
	const randPart = new Array(16);
	// Pack 10 bytes (80 bits) into 16 base-32 digits
	// Each digit = 5 bits, so we walk a bit cursor across the byte array.
	let bitCursor = 0;
	for (let i = 0; i < 16; i++) {
		const byteIdx = (bitCursor >> 3);          // which byte
		const bitOffset = bitCursor & 7;            // bit offset within that byte
		// Grab up to 2 bytes and extract 5 bits
		const twoBytes = (randomBytes[byteIdx] << 8) | (randomBytes[byteIdx + 1] ?? 0);
		const value = (twoBytes >> (11 - bitOffset)) & 0x1f;
		randPart[i] = CROCKFORD_BASE32[value];
		bitCursor += 5;
	}

	return timePart.join('') + randPart.join('');
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
