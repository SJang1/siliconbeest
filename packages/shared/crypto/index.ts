/**
 * Shared Cryptographic Utilities for ActivityPub Federation
 *
 * This package consolidates all HTTP Signature and key management code
 * that was previously duplicated across the main worker and queue consumer.
 */

// Key management
export {
	parsePemToBuffer,
	importPrivateKey,
	importPublicKey,
	importRsaKeyPairFromPem,
	importEd25519KeyPairFromBase64url,
} from './keys';

// Digest computation
export {
	bytesToBase64,
	computeDigest,
	computeContentDigest,
} from './digest';

// Draft-cavage signing
export { signRequestCavage } from './sign-cavage';

// RFC 9421 signing
export { signRequestRFC9421 } from './sign-rfc9421';

// Verification (both standards)
export {
	isTimestampFresh,
	verifySignatureCavage,
	verifySignatureRFC9421,
	extractKeyIdFromSignatureInput,
} from './verify';
