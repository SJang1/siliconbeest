/**
 * HTTP Signatures for ActivityPub Federation
 *
 * Re-exports from the consolidated shared crypto package.
 * All signing and verification logic now lives in packages/shared/crypto/.
 *
 * This file is kept as a re-export shim for backwards compatibility
 * with any code that may import from this path.
 */

export {
	parsePemToBuffer as parsePemKey,
	importPrivateKey,
	importPublicKey,
	importRsaKeyPairFromPem,
	bytesToBase64,
	computeDigest,
	computeContentDigest,
	isTimestampFresh,
	extractKeyIdFromSignatureInput,
} from '../../../../packages/shared/crypto';

export { signRequestCavage as signRequest } from '../../../../packages/shared/crypto';
export { signRequestRFC9421 } from '../../../../packages/shared/crypto';
export { verifySignatureCavage as verifySignature } from '../../../../packages/shared/crypto';
export { verifySignatureRFC9421 } from '../../../../packages/shared/crypto';
