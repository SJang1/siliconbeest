import bcrypt from 'bcryptjs';

/**
 * Hash a password using bcryptjs with cost factor 10.
 */
export async function hashPassword(password: string): Promise<string> {
	const salt = await bcrypt.genSalt(10);
	return bcrypt.hash(password, salt);
}

/**
 * Verify a password against a bcrypt hash.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
	return bcrypt.compare(password, hash);
}

/**
 * Generate a cryptographically secure random hex token.
 * @param length - Number of hex characters (default 64, which is 32 bytes).
 */
export function generateToken(length: number = 64): string {
	const byteLength = Math.ceil(length / 2);
	const bytes = generateSecureRandom(byteLength);
	const hex = Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return hex.slice(0, length);
}

/**
 * Generate a cryptographically secure random byte array.
 */
export function generateSecureRandom(bytes: number): Uint8Array {
	const array = new Uint8Array(bytes);
	crypto.getRandomValues(array);
	return array;
}

/**
 * Compute the SHA-256 hex digest of a string.
 */
export async function sha256(data: string): Promise<string> {
	const encoder = new TextEncoder();
	const encoded = encoder.encode(data);
	const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
	const hashArray = new Uint8Array(hashBuffer);
	return Array.from(hashArray)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * @param plaintext - The string to encrypt.
 * @param keyHex - 256-bit key as a 64-character hex string.
 * @returns Base64-encoded string of iv:ciphertext:tag.
 */
export async function encryptAESGCM(plaintext: string, keyHex: string): Promise<string> {
	const keyBytes = hexToBytes(keyHex);
	const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);

	const iv = generateSecureRandom(12); // 96-bit IV for AES-GCM
	const encoder = new TextEncoder();
	const plaintextBytes = encoder.encode(plaintext);

	const ciphertextBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, plaintextBytes);

	// Web Crypto appends the auth tag to the ciphertext
	const ciphertextWithTag = new Uint8Array(ciphertextBuffer);
	const ciphertext = ciphertextWithTag.slice(0, ciphertextWithTag.length - 16);
	const tag = ciphertextWithTag.slice(ciphertextWithTag.length - 16);

	// Concatenate iv:ciphertext:tag and encode as base64
	const combined = new Uint8Array(iv.length + ciphertext.length + tag.length);
	combined.set(iv, 0);
	combined.set(ciphertext, iv.length);
	combined.set(tag, iv.length + ciphertext.length);

	return bytesToBase64(combined);
}

/**
 * Decrypt AES-256-GCM encrypted data.
 * @param encrypted - Base64-encoded string containing iv (12 bytes) + ciphertext + tag (16 bytes).
 * @param keyHex - 256-bit key as a 64-character hex string.
 * @returns The decrypted plaintext string.
 */
export async function decryptAESGCM(encrypted: string, keyHex: string): Promise<string> {
	const keyBytes = hexToBytes(keyHex);
	const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);

	const combined = base64ToBytes(encrypted);

	const iv = combined.slice(0, 12);
	const ciphertext = combined.slice(12, combined.length - 16);
	const tag = combined.slice(combined.length - 16);

	// Web Crypto expects ciphertext + tag concatenated
	const ciphertextWithTag = new Uint8Array(ciphertext.length + tag.length);
	ciphertextWithTag.set(ciphertext, 0);
	ciphertextWithTag.set(tag, ciphertext.length);

	const plaintextBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, ciphertextWithTag);

	const decoder = new TextDecoder();
	return decoder.decode(plaintextBuffer);
}

// ============================================================
// Ed25519 KEY GENERATION
// ============================================================

/**
 * Generate an Ed25519 keypair for Object Integrity Proofs (FEP-8b32).
 * Keys are exported as raw bytes and base64url encoded for storage.
 */
export async function generateEd25519KeyPair(): Promise<{ publicKey: string; privateKey: string }> {
	const keyPair = await crypto.subtle.generateKey(
		'Ed25519',
		true,
		['sign', 'verify'],
	) as CryptoKeyPair;

	const publicKeyBuffer = await crypto.subtle.exportKey('raw', keyPair.publicKey);
	const privateKeyBuffer = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);

	const publicKey = bytesToBase64Url(new Uint8Array(publicKeyBuffer as ArrayBuffer));
	const privateKey = bytesToBase64Url(new Uint8Array(privateKeyBuffer as ArrayBuffer));

	return { publicKey, privateKey };
}

/**
 * Import an Ed25519 private key from base64url-encoded PKCS8 for signing.
 */
export async function importEd25519PrivateKey(base64url: string): Promise<CryptoKey> {
	const keyData = base64UrlToBytes(base64url);
	return crypto.subtle.importKey(
		'pkcs8',
		keyData,
		'Ed25519',
		false,
		['sign'],
	);
}

/**
 * Import an Ed25519 public key from base64url-encoded raw bytes for verification.
 */
export async function importEd25519PublicKey(base64url: string): Promise<CryptoKey> {
	const keyData = base64UrlToBytes(base64url);
	return crypto.subtle.importKey(
		'raw',
		keyData,
		'Ed25519',
		false,
		['verify'],
	);
}

/**
 * Sign data with an Ed25519 private key.
 */
export async function ed25519Sign(privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
	const signature = await crypto.subtle.sign('Ed25519', privateKey, data);
	return new Uint8Array(signature);
}

/**
 * Verify an Ed25519 signature.
 */
export async function ed25519Verify(publicKey: CryptoKey, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
	return crypto.subtle.verify('Ed25519', publicKey, signature, data);
}

/**
 * Compute SHA-256 hash as raw bytes.
 */
export async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	return new Uint8Array(hashBuffer);
}

// ============================================================
// BASE58BTC ENCODING (for Multibase / Multicodec)
// ============================================================

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Encode bytes to base58btc string.
 */
export function base58btcEncode(bytes: Uint8Array): string {
	if (bytes.length === 0) return '';

	// Count leading zeros
	let zeroes = 0;
	for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
		zeroes++;
	}

	// Allocate enough space in big-endian base58 representation
	const size = Math.ceil(bytes.length * 138 / 100) + 1;
	const b58 = new Uint8Array(size);

	let length = 0;
	for (let i = zeroes; i < bytes.length; i++) {
		let carry = bytes[i];
		let j = 0;
		for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
			carry += 256 * b58[k];
			b58[k] = carry % 58;
			carry = Math.floor(carry / 58);
		}
		length = j;
	}

	// Skip leading zeroes in base58 result
	let startIdx = size - length;
	while (startIdx < size && b58[startIdx] === 0) {
		startIdx++;
	}

	let result = '';
	for (let i = 0; i < zeroes; i++) {
		result += '1';
	}
	for (let i = startIdx; i < size; i++) {
		result += BASE58_ALPHABET[b58[i]];
	}

	return result;
}

/**
 * Decode a base58btc string to bytes.
 */
export function base58btcDecode(str: string): Uint8Array {
	if (str.length === 0) return new Uint8Array(0);

	// Count leading '1's (= leading zero bytes)
	let zeroes = 0;
	for (let i = 0; i < str.length && str[i] === '1'; i++) {
		zeroes++;
	}

	const size = Math.ceil(str.length * 733 / 1000) + 1;
	const b256 = new Uint8Array(size);

	let length = 0;
	for (let i = zeroes; i < str.length; i++) {
		const ch = BASE58_ALPHABET.indexOf(str[i]);
		if (ch < 0) throw new Error(`Invalid base58 character: ${str[i]}`);

		let carry = ch;
		let j = 0;
		for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
			carry += 58 * b256[k];
			b256[k] = carry % 256;
			carry = Math.floor(carry / 256);
		}
		length = j;
	}

	let startIdx = size - length;
	while (startIdx < size && b256[startIdx] === 0) {
		startIdx++;
	}

	const result = new Uint8Array(zeroes + (size - startIdx));
	// Leading zeroes are already 0 in the Uint8Array
	result.set(b256.subarray(startIdx), zeroes);

	return result;
}

/**
 * Encode an Ed25519 public key as a Multikey `publicKeyMultibase` value.
 * Format: 'z' prefix + base58btc(0xed01 + 32-byte raw public key)
 */
export function encodeEd25519PublicKeyMultibase(rawPublicKeyBase64url: string): string {
	const rawKey = base64UrlToBytes(rawPublicKeyBase64url);
	// Prepend the Ed25519 multicodec prefix 0xed, 0x01
	const prefixed = new Uint8Array(2 + rawKey.length);
	prefixed[0] = 0xed;
	prefixed[1] = 0x01;
	prefixed.set(rawKey, 2);
	return 'z' + base58btcEncode(prefixed);
}

/**
 * Decode a Multikey `publicKeyMultibase` value to raw Ed25519 public key bytes.
 * Expects: 'z' prefix + base58btc(0xed01 + 32-byte raw public key)
 */
export function decodeEd25519PublicKeyMultibase(multibase: string): Uint8Array {
	if (!multibase.startsWith('z')) {
		throw new Error('Only base58btc multibase (z prefix) is supported');
	}
	const decoded = base58btcDecode(multibase.slice(1));
	if (decoded.length < 2 || decoded[0] !== 0xed || decoded[1] !== 0x01) {
		throw new Error('Invalid Ed25519 multicodec prefix');
	}
	return decoded.slice(2);
}

// --- Internal helpers ---

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
	}
	return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

export function base64UrlToBytes(base64url: string): Uint8Array {
	const base64 = base64url
		.replace(/-/g, '+')
		.replace(/_/g, '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	return base64ToBytes(padded);
}
