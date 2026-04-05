/**
 * Object Integrity Proofs (FEP-8b32) for Queue Consumer
 *
 * Implements the eddsa-jcs-2022 cryptosuite for creating
 * Data Integrity Proofs on outgoing ActivityPub activities.
 */

import { base64UrlToBytes } from '../../../packages/shared/crypto/keys';

// ============================================================
// BASE58BTC ENCODING
// ============================================================

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58btcEncode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';

  let zeroes = 0;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    zeroes++;
  }

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

// ============================================================
// JCS (JSON Canonicalization Scheme - RFC 8785)
// ============================================================

function jcsCanonicalize(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!isFinite(value)) {
      throw new Error('JCS does not support Infinity or NaN');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return jcsSerializeString(value);
  }
  if (Array.isArray(value)) {
    const elements = value.map((item) => jcsCanonicalize(item));
    return `[${elements.join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const members: string[] = [];
    for (const key of keys) {
      if (obj[key] === undefined) continue;
      members.push(`${jcsSerializeString(key)}:${jcsCanonicalize(obj[key])}`);
    }
    return `{${members.join(',')}}`;
  }
  throw new Error(`JCS: unsupported type ${typeof value}`);
}

function jcsSerializeString(str: string): string {
  let result = '"';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 0x08) result += '\\b';
    else if (code === 0x09) result += '\\t';
    else if (code === 0x0a) result += '\\n';
    else if (code === 0x0c) result += '\\f';
    else if (code === 0x0d) result += '\\r';
    else if (code === 0x22) result += '\\"';
    else if (code === 0x5c) result += '\\\\';
    else if (code < 0x20) result += `\\u${code.toString(16).padStart(4, '0')}`;
    else result += str[i];
  }
  result += '"';
  return result;
}

// ============================================================
// PROOF CREATION
// ============================================================

/**
 * Create a Data Integrity Proof (FEP-8b32, eddsa-jcs-2022) for an activity.
 *
 * @param activity - The activity object (proof field will be stripped before signing)
 * @param ed25519PrivateKeyBase64url - The Ed25519 private key in base64url-encoded PKCS8
 * @param keyId - The verification method ID (e.g. "https://domain/users/username#ed25519-key")
 * @returns The activity object with `proof` attached
 */
export async function createProof(
  activity: Record<string, unknown>,
  ed25519PrivateKeyBase64url: string,
  keyId: string,
): Promise<Record<string, unknown>> {
  const now = new Date().toISOString();
  const encoder = new TextEncoder();

  // Build proof options (without proofValue)
  const proofOptions = {
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    verificationMethod: keyId,
    proofPurpose: 'assertionMethod',
    created: now,
  };

  // 1. JCS canonicalize proof options
  const canonicalProofOptions = jcsCanonicalize(proofOptions);

  // 2. SHA-256 hash the proof options
  const proofOptionsHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(canonicalProofOptions)),
  );

  // 3. JCS canonicalize the document (without proof field)
  const documentWithoutProof = { ...activity };
  delete documentWithoutProof.proof;
  const canonicalDocument = jcsCanonicalize(documentWithoutProof);

  // 4. SHA-256 hash the document
  const documentHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(canonicalDocument)),
  );

  // 5. Concatenate hashes (proof options hash + document hash)
  const combined = new Uint8Array(proofOptionsHash.length + documentHash.length);
  combined.set(proofOptionsHash, 0);
  combined.set(documentHash, proofOptionsHash.length);

  // 6. Import Ed25519 private key and sign
  const keyData = base64UrlToBytes(ed25519PrivateKeyBase64url);
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    'Ed25519',
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('Ed25519', privateKey, combined),
  );

  // 7. Base58btc encode with 'z' prefix
  const proofValue = 'z' + base58btcEncode(signature);

  // Ensure @context includes Data Integrity context
  const result: Record<string, unknown> = {
    ...activity,
    proof: {
      ...proofOptions,
      proofValue,
    },
  };

  // Add the Data Integrity context if not already present
  const diContext = 'https://w3id.org/security/data-integrity/v1';
  const ctx = result['@context'];
  if (Array.isArray(ctx)) {
    if (!ctx.includes(diContext)) {
      result['@context'] = [...ctx, diContext];
    }
  } else if (typeof ctx === 'string') {
    result['@context'] = [ctx, diContext];
  } else {
    result['@context'] = [diContext];
  }

  return result;
}
