/**
 * RFC 8291 — Message Encryption for Web Push
 *
 * Implements the aes128gcm content encoding for encrypting push
 * message payloads using Web Crypto API.
 *
 * References:
 *   - RFC 8291: Message Encryption for Web Push
 *   - RFC 8188: Encrypted Content-Encoding for HTTP (aes128gcm)
 *   - RFC 8291 §3: Key derivation
 *   - RFC 8291 §4: Encryption
 */

import { base64urlDecode } from './vapid';

// ============================================================
// HKDF-SHA-256
// ============================================================

/**
 * HKDF-SHA-256 key derivation.
 *
 * @param salt - Salt value (non-secret random value)
 * @param ikm - Input keying material
 * @param info - Context and application specific information
 * @param length - Output length in bytes
 */
async function hkdfSha256(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, [
    'deriveBits',
  ]);

  const derived = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info,
    },
    key,
    length * 8, // bits
  );

  return new Uint8Array(derived);
}

// ============================================================
// HELPERS
// ============================================================

/** Build an info string for HKDF: "Content-Encoding: <encoding>\0" */
function buildInfo(encoding: string): Uint8Array {
  const prefix = `Content-Encoding: ${encoding}\0`;
  return new TextEncoder().encode(prefix);
}

/**
 * Build the key info for the IKM derivation (RFC 8291 §3.4):
 * "WebPush: info\0" || ua_public (65 bytes) || as_public (65 bytes)
 */
function buildKeyInfoIKM(
  subscriberPublicKey: Uint8Array,
  ephemeralPublicKey: Uint8Array,
): Uint8Array {
  const prefix = new TextEncoder().encode('WebPush: info\0');
  const info = new Uint8Array(
    prefix.length + subscriberPublicKey.length + ephemeralPublicKey.length,
  );
  info.set(prefix, 0);
  info.set(subscriberPublicKey, prefix.length);
  info.set(ephemeralPublicKey, prefix.length + subscriberPublicKey.length);
  return info;
}

/** Concatenate multiple Uint8Arrays */
function concat(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// ============================================================
// MAIN ENCRYPTION
// ============================================================

/**
 * Encrypt a push message payload per RFC 8291.
 *
 * @param payload - The plaintext message (typically a JSON string)
 * @param p256dhKey - Subscriber's P-256 public key (base64url from PushSubscription.keys.p256dh)
 * @param authSecret - Subscriber's auth secret (base64url, 16 bytes, from PushSubscription.keys.auth)
 * @returns Encrypted payload body and required HTTP headers
 */
export async function encryptPushPayload(
  payload: string,
  p256dhKey: string,
  authSecret: string,
): Promise<{ body: Uint8Array; headers: Record<string, string> }> {
  // 1. Decode subscriber keys
  const subscriberPublicKeyBytes = base64urlDecode(p256dhKey);
  const authSecretBytes = base64urlDecode(authSecret);

  if (subscriberPublicKeyBytes.length !== 65) {
    throw new Error(
      `Invalid subscriber public key: expected 65 bytes, got ${subscriberPublicKeyBytes.length}`,
    );
  }
  if (authSecretBytes.length !== 16) {
    throw new Error(
      `Invalid auth secret: expected 16 bytes, got ${authSecretBytes.length}`,
    );
  }

  // 2. Import subscriber's public key for ECDH
  const subscriberPublicKey = await crypto.subtle.importKey(
    'raw',
    subscriberPublicKeyBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  // 3. Generate ephemeral ECDH P-256 key pair
  const ephemeralKeyPair = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true, // extractable so we can export the public key
    ['deriveBits'],
  )) as CryptoKeyPair;

  // 4. Export ephemeral public key (uncompressed, 65 bytes)
  const ephemeralPublicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', ephemeralKeyPair.publicKey) as ArrayBuffer,
  );

  // 5. ECDH key agreement: derive shared secret
  const sharedSecretBuffer = await crypto.subtle.deriveBits(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { name: 'ECDH', public: subscriberPublicKey } as any,
    ephemeralKeyPair.privateKey,
    256, // 32 bytes
  );
  const sharedSecret = new Uint8Array(sharedSecretBuffer);

  // 6. Derive IKM (Input Keying Material) per RFC 8291 §3.4
  //    IKM = HKDF-SHA-256(auth_secret, ecdh_secret, key_info, 32)
  const keyInfo = buildKeyInfoIKM(
    subscriberPublicKeyBytes,
    ephemeralPublicKeyBytes,
  );
  const ikm = await hkdfSha256(authSecretBytes, sharedSecret, keyInfo, 32);

  // 7. Generate a random 16-byte salt for content encryption
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // 8. Derive Content Encryption Key (CEK) — 16 bytes for AES-128
  //    CEK = HKDF-SHA-256(salt, IKM, "Content-Encoding: aes128gcm\0", 16)
  const cekInfo = buildInfo('aes128gcm');
  const cek = await hkdfSha256(salt, ikm, cekInfo, 16);

  // 9. Derive nonce — 12 bytes
  //    nonce = HKDF-SHA-256(salt, IKM, "Content-Encoding: nonce\0", 12)
  const nonceInfo = buildInfo('nonce');
  const nonce = await hkdfSha256(salt, ikm, nonceInfo, 12);

  // 10. Prepare plaintext with padding per RFC 8291 §4
  //     For aes128gcm, the padding delimiter is \x02 appended after the plaintext.
  //     Format: plaintext || \x02 || zero-padding
  //     Since we only have a single record, the delimiter \x02 marks the end.
  const payloadBytes = new TextEncoder().encode(payload);
  const paddedPlaintext = new Uint8Array(payloadBytes.length + 1);
  paddedPlaintext.set(payloadBytes, 0);
  paddedPlaintext[payloadBytes.length] = 0x02; // padding delimiter for final record

  // 11. Encrypt with AES-128-GCM
  const cekKey = await crypto.subtle.importKey(
    'raw',
    cek,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );

  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    cekKey,
    paddedPlaintext,
  );
  const encryptedBytes = new Uint8Array(encryptedBuffer);

  // 12. Build the aes128gcm header (RFC 8188 §2.1)
  //     header = salt (16 bytes) || rs (4 bytes, big-endian) || idlen (1 byte) || keyid (65 bytes)
  //     rs = record size = 4096 (standard)
  //     keyid = ephemeral public key (uncompressed)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false); // big-endian

  const idlen = new Uint8Array([ephemeralPublicKeyBytes.length]); // 65

  const header = concat(salt, rs, idlen, ephemeralPublicKeyBytes);

  // 13. Concatenate header + encrypted data
  const body = concat(header, encryptedBytes);

  return {
    body,
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
    },
  };
}
