/**
 * Cryptographic Key Utilities
 *
 * Consolidated PEM parsing and key import functions for ActivityPub
 * HTTP Signatures. Used by both the main worker (Fedify dispatchers)
 * and the queue consumer (activity delivery).
 *
 * Previously duplicated in:
 *   - federation/httpSignatures.ts
 *   - federation/helpers/key-utils.ts
 *   - siliconbeest-queue-consumer/src/handlers/deliverActivity.ts
 */

// ============================================================
// PEM PARSING
// ============================================================

/**
 * Strip PEM headers/footers and base64-decode the key material
 * into a raw ArrayBuffer.
 *
 * Handles any PEM type (RSA PRIVATE KEY, PUBLIC KEY, etc.)
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

const RSA_ALGORITHM = {
	name: 'RSASSA-PKCS1-v1_5',
	hash: { name: 'SHA-256' },
} as const;

/**
 * Import a PKCS8-encoded PEM private key for RSASSA-PKCS1-v1_5 SHA-256 signing.
 */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'pkcs8',
		parsePemToBuffer(pem),
		RSA_ALGORITHM,
		false,
		['sign'],
	);
}

/**
 * Import a SPKI-encoded PEM public key for RSASSA-PKCS1-v1_5 SHA-256 verification.
 */
export async function importPublicKey(pem: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'spki',
		parsePemToBuffer(pem),
		RSA_ALGORITHM,
		false,
		['verify'],
	);
}

/**
 * Import an RSA key pair from PEM-encoded strings into a CryptoKeyPair.
 *
 * Used by the Fedify KeyPairs dispatcher to provide signing keys.
 */
export async function importRsaKeyPairFromPem(
	publicKeyPem: string,
	privateKeyPem: string,
): Promise<CryptoKeyPair> {
	const [publicKey, privateKey] = await Promise.all([
		crypto.subtle.importKey(
			'spki',
			parsePemToBuffer(publicKeyPem),
			RSA_ALGORITHM,
			true,
			['verify'],
		),
		crypto.subtle.importKey(
			'pkcs8',
			parsePemToBuffer(privateKeyPem),
			RSA_ALGORITHM,
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
 * in PKCS8 format. Used for Object Integrity Proofs (FEP-8b32) and Fedify's
 * Ed25519 key pair support.
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
