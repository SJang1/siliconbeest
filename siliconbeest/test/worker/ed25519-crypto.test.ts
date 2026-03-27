import { describe, it, expect } from 'vitest';
import {
	generateEd25519KeyPair,
	importEd25519PrivateKey,
	importEd25519PublicKey,
	ed25519Sign,
	ed25519Verify,
	base58btcEncode,
	base58btcDecode,
	encodeEd25519PublicKeyMultibase,
	decodeEd25519PublicKeyMultibase,
	base64UrlToBytes,
} from '../src/utils/crypto';

describe('Ed25519 Crypto Utilities', () => {
	// ---------------------------------------------------------------
	// Key generation
	// ---------------------------------------------------------------
	describe('generateEd25519KeyPair()', () => {
		it('returns publicKey and privateKey as base64url strings', async () => {
			const keys = await generateEd25519KeyPair();

			expect(keys).toHaveProperty('publicKey');
			expect(keys).toHaveProperty('privateKey');
			expect(typeof keys.publicKey).toBe('string');
			expect(typeof keys.privateKey).toBe('string');
			expect(keys.publicKey.length).toBeGreaterThan(0);
			expect(keys.privateKey.length).toBeGreaterThan(0);
		});

		it('public key decodes to 32 bytes (raw Ed25519)', async () => {
			const keys = await generateEd25519KeyPair();
			const publicKeyBytes = base64UrlToBytes(keys.publicKey);
			expect(publicKeyBytes.length).toBe(32);
		});

		it('generates different keys each time', async () => {
			const keys1 = await generateEd25519KeyPair();
			const keys2 = await generateEd25519KeyPair();
			expect(keys1.publicKey).not.toBe(keys2.publicKey);
			expect(keys1.privateKey).not.toBe(keys2.privateKey);
		});
	});

	// ---------------------------------------------------------------
	// Base58btc encode/decode
	// ---------------------------------------------------------------
	describe('base58btcEncode() / base58btcDecode()', () => {
		it('round-trips arbitrary bytes', () => {
			const original = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128]);
			const encoded = base58btcEncode(original);
			const decoded = base58btcDecode(encoded);
			expect(decoded).toEqual(original);
		});

		it('handles empty input', () => {
			expect(base58btcEncode(new Uint8Array(0))).toBe('');
			expect(base58btcDecode('')).toEqual(new Uint8Array(0));
		});

		it('handles leading zeros', () => {
			const original = new Uint8Array([0, 0, 0, 1, 2, 3]);
			const encoded = base58btcEncode(original);
			expect(encoded.startsWith('111')).toBe(true); // Leading zeros become '1's
			const decoded = base58btcDecode(encoded);
			expect(decoded).toEqual(original);
		});

		it('round-trips a 32-byte key', () => {
			const key = new Uint8Array(32);
			crypto.getRandomValues(key);
			const encoded = base58btcEncode(key);
			const decoded = base58btcDecode(encoded);
			expect(decoded).toEqual(key);
		});

		it('encodes to valid base58btc characters only', () => {
			const data = new Uint8Array([10, 20, 30, 40, 50]);
			const encoded = base58btcEncode(data);
			const validChars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
			for (const ch of encoded) {
				expect(validChars).toContain(ch);
			}
		});

		it('throws on invalid base58 character', () => {
			expect(() => base58btcDecode('0OIl')).toThrow();
		});
	});

	// ---------------------------------------------------------------
	// Multibase encode/decode for Ed25519
	// ---------------------------------------------------------------
	describe('encodeEd25519PublicKeyMultibase() / decodeEd25519PublicKeyMultibase()', () => {
		it('produces z6Mk... format', async () => {
			const keys = await generateEd25519KeyPair();
			const multibase = encodeEd25519PublicKeyMultibase(keys.publicKey);
			expect(multibase.startsWith('z')).toBe(true);
			// The multicodec prefix 0xed01 followed by 32 bytes encodes to
			// a base58btc string that typically starts with "6Mk"
			expect(multibase.startsWith('z6Mk')).toBe(true);
		});

		it('round-trips correctly', async () => {
			const keys = await generateEd25519KeyPair();
			const multibase = encodeEd25519PublicKeyMultibase(keys.publicKey);
			const decodedRawKey = decodeEd25519PublicKeyMultibase(multibase);

			const originalRawKey = base64UrlToBytes(keys.publicKey);
			expect(decodedRawKey).toEqual(originalRawKey);
		});

		it('throws for non-z prefix', () => {
			expect(() => decodeEd25519PublicKeyMultibase('m1234')).toThrow(
				'Only base58btc multibase (z prefix) is supported',
			);
		});

		it('throws for invalid multicodec prefix', () => {
			// Create a multibase with wrong prefix bytes
			const wrongPrefix = new Uint8Array([0x00, 0x01, ...new Uint8Array(32)]);
			const encoded = 'z' + base58btcEncode(wrongPrefix);
			expect(() => decodeEd25519PublicKeyMultibase(encoded)).toThrow(
				'Invalid Ed25519 multicodec prefix',
			);
		});
	});

	// ---------------------------------------------------------------
	// Ed25519 sign/verify round-trip
	// ---------------------------------------------------------------
	describe('Ed25519 sign/verify', () => {
		it('sign then verify succeeds with matching keys', async () => {
			const keys = await generateEd25519KeyPair();
			const privateKey = await importEd25519PrivateKey(keys.privateKey);
			const publicKey = await importEd25519PublicKey(keys.publicKey);

			const data = new TextEncoder().encode('Hello, Ed25519!');
			const signature = await ed25519Sign(privateKey, data);

			expect(signature).toBeInstanceOf(Uint8Array);
			expect(signature.length).toBe(64); // Ed25519 signatures are 64 bytes

			const valid = await ed25519Verify(publicKey, signature, data);
			expect(valid).toBe(true);
		});

		it('verification fails with wrong data', async () => {
			const keys = await generateEd25519KeyPair();
			const privateKey = await importEd25519PrivateKey(keys.privateKey);
			const publicKey = await importEd25519PublicKey(keys.publicKey);

			const data = new TextEncoder().encode('Original message');
			const signature = await ed25519Sign(privateKey, data);

			const wrongData = new TextEncoder().encode('Tampered message');
			const valid = await ed25519Verify(publicKey, signature, wrongData);
			expect(valid).toBe(false);
		});

		it('verification fails with wrong public key', async () => {
			const keys1 = await generateEd25519KeyPair();
			const keys2 = await generateEd25519KeyPair();
			const privateKey = await importEd25519PrivateKey(keys1.privateKey);
			const wrongPublicKey = await importEd25519PublicKey(keys2.publicKey);

			const data = new TextEncoder().encode('Test message');
			const signature = await ed25519Sign(privateKey, data);

			const valid = await ed25519Verify(wrongPublicKey, signature, data);
			expect(valid).toBe(false);
		});

		it('signs different data to produce different signatures', async () => {
			const keys = await generateEd25519KeyPair();
			const privateKey = await importEd25519PrivateKey(keys.privateKey);

			const data1 = new TextEncoder().encode('Message 1');
			const data2 = new TextEncoder().encode('Message 2');

			const sig1 = await ed25519Sign(privateKey, data1);
			const sig2 = await ed25519Sign(privateKey, data2);

			// Signatures should be different for different messages
			const sig1Hex = Array.from(sig1).map((b) => b.toString(16)).join('');
			const sig2Hex = Array.from(sig2).map((b) => b.toString(16)).join('');
			expect(sig1Hex).not.toBe(sig2Hex);
		});
	});
});
