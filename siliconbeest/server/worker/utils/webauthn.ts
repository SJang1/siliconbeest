/**
 * WebAuthn utilities using Web Crypto API only (no npm packages).
 *
 * Provides base64url encoding/decoding, authenticator data parsing,
 * COSE key import, and assertion signature verification.
 */

import { decodeCBOR } from './cbor';

// ---------------------------------------------------------------------------
// Base64url encoding / decoding
// ---------------------------------------------------------------------------

export function base64urlEncode(buf: ArrayBuffer | Uint8Array): string {
	const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

export function base64urlDecode(str: string): Uint8Array {
	// Strip any whitespace or newlines
	let s = str.replace(/[\s\n\r]/g, '');
	// Replace URL-safe chars
	s = s.replace(/-/g, '+').replace(/_/g, '/');
	// Add padding
	while (s.length % 4 !== 0) s += '=';
	// Use a safer decode that handles edge cases
	try {
		const binary = atob(s);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	} catch {
		// Fallback: manual base64 decode without atob
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
		const lookup = new Uint8Array(256);
		for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
		const len = s.length;
		let bufLen = (len * 3) >> 2;
		if (s[len - 1] === '=') bufLen--;
		if (s[len - 2] === '=') bufLen--;
		const buf = new Uint8Array(bufLen);
		let p = 0;
		for (let i = 0; i < len; i += 4) {
			const a = lookup[s.charCodeAt(i)]!;
			const b = lookup[s.charCodeAt(i + 1)]!;
			const c = lookup[s.charCodeAt(i + 2)]!;
			const d = lookup[s.charCodeAt(i + 3)]!;
			buf[p++] = (a << 2) | (b >> 4);
			if (p < bufLen) buf[p++] = ((b & 15) << 4) | (c >> 2);
			if (p < bufLen) buf[p++] = ((c & 3) << 6) | d;
		}
		return buf;
	}
}

// ---------------------------------------------------------------------------
// Authenticator data parsing
// ---------------------------------------------------------------------------

export interface AuthenticatorDataFlags {
	up: boolean; // User Present
	uv: boolean; // User Verified
	at: boolean; // Attested Credential Data present
	ed: boolean; // Extension Data present
}

export interface AttestedCredentialData {
	aaguid: Uint8Array;
	credentialId: Uint8Array;
	publicKey: Map<number, any>;
}

export interface ParsedAuthenticatorData {
	rpIdHash: Uint8Array;
	flags: AuthenticatorDataFlags;
	signCount: number;
	attestedCredentialData?: AttestedCredentialData;
}

/**
 * Parse the raw authenticator data bytes from a WebAuthn response.
 * See https://www.w3.org/TR/webauthn-3/#authenticator-data
 */
export function parseAuthenticatorData(authData: Uint8Array): ParsedAuthenticatorData {
	if (authData.length < 37) {
		throw new Error('Authenticator data too short');
	}

	const rpIdHash = authData.slice(0, 32);
	const flagsByte = authData[32]!;
	const flags: AuthenticatorDataFlags = {
		up: !!(flagsByte & 0x01),
		uv: !!(flagsByte & 0x04),
		at: !!(flagsByte & 0x40),
		ed: !!(flagsByte & 0x80),
	};

	const signCount = new DataView(
		authData.buffer,
		authData.byteOffset + 33,
		4,
	).getUint32(0);

	const result: ParsedAuthenticatorData = { rpIdHash, flags, signCount };

	if (flags.at) {
		// Parse attested credential data
		let offset = 37;

		const aaguid = authData.slice(offset, offset + 16);
		offset += 16;

		const credIdLength = new DataView(
			authData.buffer,
			authData.byteOffset + offset,
			2,
		).getUint16(0);
		offset += 2;

		const credentialId = authData.slice(offset, offset + credIdLength);
		offset += credIdLength;

		// The remaining bytes (before any extensions) are the CBOR-encoded COSE public key
		const publicKey = decodeCBOR(authData.slice(offset)) as Map<number, any>;

		result.attestedCredentialData = {
			aaguid,
			credentialId,
			publicKey,
		};
	}

	return result;
}

// ---------------------------------------------------------------------------
// COSE key → CryptoKey
// ---------------------------------------------------------------------------

// COSE key type identifiers
const COSE_KTY = 1;
const COSE_ALG = 3;

// COSE EC2 key parameters
const COSE_EC2_CRV = -1;
const COSE_EC2_X = -2;
const COSE_EC2_Y = -3;

// COSE RSA key parameters
const COSE_RSA_N = -1;
const COSE_RSA_E = -2;

/**
 * Convert a COSE public key (Map) to a Web Crypto CryptoKey.
 * Supports ES256 (alg=-7) and RS256 (alg=-257).
 */
export async function coseKeyToCryptoKey(coseKey: Map<number, any>): Promise<CryptoKey> {
	const alg = coseKey.get(COSE_ALG);

	if (alg === -7) {
		// ES256 — ECDSA with P-256
		return importES256Key(coseKey);
	} else if (alg === -257) {
		// RS256 — RSASSA-PKCS1-v1_5 with SHA-256
		return importRS256Key(coseKey);
	}

	throw new Error(`Unsupported COSE algorithm: ${alg}`);
}

async function importES256Key(coseKey: Map<number, any>): Promise<CryptoKey> {
	const x = coseKey.get(COSE_EC2_X) as Uint8Array;
	const y = coseKey.get(COSE_EC2_Y) as Uint8Array;

	if (!x || !y) {
		throw new Error('ES256 key missing x or y coordinate');
	}

	// Build uncompressed point: 0x04 || x || y
	const rawKey = new Uint8Array(1 + x.length + y.length);
	rawKey[0] = 0x04;
	rawKey.set(x, 1);
	rawKey.set(y, 1 + x.length);

	return crypto.subtle.importKey(
		'raw',
		rawKey,
		{ name: 'ECDSA', namedCurve: 'P-256' },
		true,
		['verify'],
	);
}

async function importRS256Key(coseKey: Map<number, any>): Promise<CryptoKey> {
	const n = coseKey.get(COSE_RSA_N) as Uint8Array;
	const e = coseKey.get(COSE_RSA_E) as Uint8Array;

	if (!n || !e) {
		throw new Error('RS256 key missing n or e');
	}

	const jwk: JsonWebKey = {
		kty: 'RSA',
		n: base64urlEncode(n),
		e: base64urlEncode(e),
		alg: 'RS256',
	};

	return crypto.subtle.importKey(
		'jwk',
		jwk,
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		true,
		['verify'],
	);
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verify a WebAuthn assertion signature.
 *
 * The signed message is: authData || clientDataHash
 *
 * For ES256 (alg=-7): the signature from the authenticator is DER-encoded
 * and must be converted to raw r||s format for Web Crypto.
 *
 * For RS256 (alg=-257): the signature is used as-is.
 */
export async function verifySignature(
	publicKey: CryptoKey,
	authData: Uint8Array,
	clientDataHash: Uint8Array,
	signature: Uint8Array,
	algorithm: number,
): Promise<boolean> {
	// Build the signed data: authData || clientDataHash
	const signedData = new Uint8Array(authData.length + clientDataHash.length);
	signedData.set(authData, 0);
	signedData.set(clientDataHash, authData.length);

	if (algorithm === -7) {
		// ES256: convert DER signature to raw r||s
		const rawSig = derToRaw(signature);
		return crypto.subtle.verify(
			{ name: 'ECDSA', hash: 'SHA-256' },
			publicKey,
			rawSig,
			signedData,
		);
	} else if (algorithm === -257) {
		// RS256: signature is already in correct format
		return crypto.subtle.verify(
			{ name: 'RSASSA-PKCS1-v1_5' },
			publicKey,
			signature,
			signedData,
		);
	}

	throw new Error(`Unsupported algorithm for verification: ${algorithm}`);
}

// ---------------------------------------------------------------------------
// DER signature → raw r||s conversion (for ES256 / P-256)
// ---------------------------------------------------------------------------

/**
 * Convert a DER-encoded ECDSA signature to the raw r||s format
 * expected by Web Crypto API (64 bytes for P-256: 32-byte r + 32-byte s).
 */
function derToRaw(derSig: Uint8Array): Uint8Array {
	// DER format: 0x30 <totalLen> 0x02 <rLen> <r> 0x02 <sLen> <s>
	if (derSig[0] !== 0x30) {
		throw new Error('Invalid DER signature: missing SEQUENCE tag');
	}

	let offset = 2; // skip 0x30 and total length

	// Handle long form length encoding
	if (derSig[1]! & 0x80) {
		const lenBytes = derSig[1]! & 0x7f;
		offset = 2 + lenBytes;
	}

	// Read r
	if (derSig[offset] !== 0x02) {
		throw new Error('Invalid DER signature: missing INTEGER tag for r');
	}
	offset += 1;
	const rLen = derSig[offset]!;
	offset += 1;
	let r = derSig.slice(offset, offset + rLen);
	offset += rLen;

	// Read s
	if (derSig[offset] !== 0x02) {
		throw new Error('Invalid DER signature: missing INTEGER tag for s');
	}
	offset += 1;
	const sLen = derSig[offset]!;
	offset += 1;
	let s = derSig.slice(offset, offset + sLen);

	// Normalize r and s to exactly 32 bytes each (for P-256)
	r = normalizeInteger(r, 32) as Uint8Array<ArrayBuffer>;
	s = normalizeInteger(s, 32) as Uint8Array<ArrayBuffer>;

	const raw = new Uint8Array(64);
	raw.set(r, 0);
	raw.set(s, 32);
	return raw;
}

/**
 * Normalize a DER integer to a fixed-length byte array.
 * Removes leading zero padding (used for positive sign) and
 * left-pads with zeros if shorter than expected.
 */
function normalizeInteger(buf: Uint8Array, length: number): Uint8Array {
	if (buf.length > length) {
		// Remove leading zero(es) — DER adds 0x00 prefix when high bit is set
		buf = buf.slice(buf.length - length);
	}
	if (buf.length < length) {
		const padded = new Uint8Array(length);
		padded.set(buf, length - buf.length);
		return padded;
	}
	return buf;
}
