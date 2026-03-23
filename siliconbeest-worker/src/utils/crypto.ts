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
