/**
 * Digest Computation
 *
 * SHA-256 digest functions for HTTP Signature verification
 * in both draft-cavage and RFC 9421/9530 formats.
 */

/**
 * Helper to encode bytes to base64.
 */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

/**
 * Compute SHA-256 digest in the `SHA-256=base64(...)` format
 * used by the draft-cavage Digest header.
 */
export async function computeDigest(body: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(body);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	return `SHA-256=${bytesToBase64(new Uint8Array(hashBuffer))}`;
}

/**
 * Compute Content-Digest per RFC 9530.
 * Format: `sha-256=:BASE64:` (structured field byte sequence)
 */
export async function computeContentDigest(body: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(body);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	return `sha-256=:${bytesToBase64(new Uint8Array(hashBuffer))}:`;
}
