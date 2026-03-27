/**
 * PEM-to-CryptoKey Utilities
 *
 * Clean utility functions for importing cryptographic keys from PEM and
 * base64url formats into Web Crypto API CryptoKey objects.
 *
 * These are used by the Fedify KeyPairs dispatcher to provide signing
 * keys for ActivityPub federation.
 *
 * Based on existing implementations in:
 * - src/utils/crypto.ts (Ed25519 base64url import)
 */

// ============================================================
// PEM PARSING
// ============================================================

/**
 * Strip PEM headers/footers and base64-decode the key material
 * into a raw ArrayBuffer.
 *
 * Handles any PEM type (RSA PRIVATE KEY, PUBLIC KEY, etc.)
 *
 * @param pem - PEM-encoded key string
 * @returns The raw key bytes as an ArrayBuffer
 */
export function parsePemToBuffer(pem: string): ArrayBuffer {
	const lines = pem
		.replace(/-----BEGIN [A-Z ]+-----/, '')
		.replace(/-----END [A-Z ]+-----/, '')
		.replace(/\r?\n/g, '')
		.trim();
	const binaryString = atob(lines);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes.buffer;
}

// ============================================================
// RSA KEY IMPORT
// ============================================================

/**
 * Import an RSA key pair from PEM-encoded strings into a CryptoKeyPair.
 *
 * Uses RSASSA-PKCS1-v1_5 with SHA-256, which is the standard algorithm
 * for ActivityPub HTTP Signatures (draft-cavage and RFC 9421).
 *
 * @param publicKeyPem - SPKI-encoded PEM public key
 * @param privateKeyPem - PKCS8-encoded PEM private key
 * @returns A CryptoKeyPair with the imported keys
 */
export async function importRsaKeyPairFromPem(
	publicKeyPem: string,
	privateKeyPem: string,
): Promise<CryptoKeyPair> {
	const algorithm = {
		name: 'RSASSA-PKCS1-v1_5',
		hash: { name: 'SHA-256' },
	};

	const [publicKey, privateKey] = await Promise.all([
		crypto.subtle.importKey(
			'spki',
			parsePemToBuffer(publicKeyPem),
			algorithm,
			true,
			['verify'],
		),
		crypto.subtle.importKey(
			'pkcs8',
			parsePemToBuffer(privateKeyPem),
			algorithm,
			true,
			['sign'],
		),
	]);

	return { publicKey, privateKey };
}

// ============================================================
// Ed25519 KEY IMPORT
// ============================================================

/**
 * Convert a base64url-encoded string to a Uint8Array.
 */
function base64UrlToBytes(base64url: string): Uint8Array {
	const base64 = base64url
		.replace(/-/g, '+')
		.replace(/_/g, '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	const binaryString = atob(padded);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes;
}

/**
 * Import an Ed25519 key pair from base64url-encoded strings into a CryptoKeyPair.
 *
 * The public key is expected in raw format (32 bytes) and the private key
 * in PKCS8 format, matching the output of `generateEd25519KeyPair()` in
 * src/utils/crypto.ts.
 *
 * Used for Object Integrity Proofs (FEP-8b32) and Fedify's Ed25519
 * key pair support.
 *
 * @param publicKeyBase64url - Raw Ed25519 public key, base64url-encoded
 * @param privateKeyBase64url - PKCS8 Ed25519 private key, base64url-encoded
 * @returns A CryptoKeyPair with the imported keys
 */
export async function importEd25519KeyPairFromBase64url(
	publicKeyBase64url: string,
	privateKeyBase64url: string,
): Promise<CryptoKeyPair> {
	const [publicKey, privateKey] = await Promise.all([
		crypto.subtle.importKey(
			'raw',
			base64UrlToBytes(publicKeyBase64url),
			'Ed25519',
			true,
			['verify'],
		),
		crypto.subtle.importKey(
			'pkcs8',
			base64UrlToBytes(privateKeyBase64url),
			'Ed25519',
			true,
			['sign'],
		),
	]);

	return { publicKey, privateKey };
}
