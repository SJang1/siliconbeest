/**
 * TOTP (Time-based One-Time Password) utilities.
 * Implements RFC 6238 using Web Crypto API (compatible with Cloudflare Workers).
 */

const TOTP_PERIOD = 30; // seconds
const TOTP_DIGITS = 6;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decode a Base32-encoded string into a Uint8Array.
 */
export function base32Decode(encoded: string): Uint8Array {
	const cleaned = encoded.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
	const output: number[] = [];
	let bits = 0;
	let value = 0;

	for (const char of cleaned) {
		const index = BASE32_ALPHABET.indexOf(char);
		if (index === -1) {
			throw new Error(`Invalid Base32 character: ${char}`);
		}
		value = (value << 5) | index;
		bits += 5;

		if (bits >= 8) {
			bits -= 8;
			output.push((value >>> bits) & 0xff);
		}
	}

	return new Uint8Array(output);
}

/**
 * Encode a Uint8Array as a Base32 string.
 */
function base32Encode(data: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let result = '';

	for (const byte of data) {
		value = (value << 8) | byte;
		bits += 8;

		while (bits >= 5) {
			bits -= 5;
			result += BASE32_ALPHABET[(value >>> bits) & 0x1f];
		}
	}

	if (bits > 0) {
		result += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
	}

	return result;
}

/**
 * Generate a random 20-byte Base32-encoded TOTP secret.
 */
export function generateTOTPSecret(): string {
	const bytes = new Uint8Array(20);
	crypto.getRandomValues(bytes);
	return base32Encode(bytes);
}

/**
 * Generate an otpauth:// URI for TOTP provisioning (e.g., QR codes).
 */
export function generateTOTPUri(secret: string, email: string, issuer: string): string {
	const encodedIssuer = encodeURIComponent(issuer);
	const encodedEmail = encodeURIComponent(email);
	return `otpauth://totp/${encodedIssuer}:${encodedEmail}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
}

/**
 * Compute HMAC-SHA1 using Web Crypto API.
 */
async function hmacSha1(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
	const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
	const signature = await crypto.subtle.sign('HMAC', cryptoKey, message);
	return new Uint8Array(signature);
}

/**
 * Generate a TOTP code for a given time counter.
 */
async function generateHOTP(secret: Uint8Array, counter: bigint): Promise<string> {
	// Convert counter to 8-byte big-endian buffer
	const counterBytes = new Uint8Array(8);
	for (let i = 7; i >= 0; i--) {
		counterBytes[i] = Number(counter & 0xffn);
		counter >>= 8n;
	}

	const hmac = await hmacSha1(secret, counterBytes);

	// Dynamic truncation (RFC 4226 Section 5.4)
	const offset = hmac[hmac.length - 1]! & 0x0f;
	const binary =
		((hmac[offset]! & 0x7f) << 24) |
		((hmac[offset + 1]! & 0xff) << 16) |
		((hmac[offset + 2]! & 0xff) << 8) |
		(hmac[offset + 3]! & 0xff);

	const otp = binary % Math.pow(10, TOTP_DIGITS);
	return otp.toString().padStart(TOTP_DIGITS, '0');
}

/**
 * Verify a TOTP token against a secret.
 * Checks the current period and +/- 1 period (to handle clock drift).
 */
export async function verifyTOTP(token: string, secret: string): Promise<boolean> {
	if (!token || token.length !== TOTP_DIGITS) {
		return false;
	}

	const secretBytes = base32Decode(secret);
	const now = Math.floor(Date.now() / 1000);
	const currentCounter = BigInt(Math.floor(now / TOTP_PERIOD));

	// Check current period and +/- 1 window
	for (let offset = -1; offset <= 1; offset++) {
		const counter = currentCounter + BigInt(offset);
		const expectedToken = await generateHOTP(secretBytes, counter);
		if (timingSafeEqual(token, expectedToken)) {
			return true;
		}
	}

	return false;
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}

/**
 * Generate random alphanumeric backup codes.
 * @param count - Number of backup codes to generate (default 10).
 */
export function generateBackupCodes(count: number = 10): string[] {
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
	const codes: string[] = [];

	for (let i = 0; i < count; i++) {
		const bytes = new Uint8Array(8);
		crypto.getRandomValues(bytes);
		let code = '';
		for (let j = 0; j < 8; j++) {
			code += chars[bytes[j]! % chars.length];
		}
		codes.push(code);
	}

	return codes;
}

/**
 * Hash a backup code using SHA-256 for secure storage.
 */
export async function hashBackupCode(code: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(code);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = new Uint8Array(hashBuffer);
	return Array.from(hashArray)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}
