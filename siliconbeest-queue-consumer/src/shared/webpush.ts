/**
 * Web Push — VAPID + RFC 8291 Encryption + Dispatch
 *
 * Self-contained Web Push implementation for the queue consumer.
 * Uses Web Crypto API exclusively (no Node.js crypto).
 *
 * This is a standalone copy of the worker's webpush modules since
 * the queue consumer cannot import directly from the worker project.
 */

// ============================================================
// BASE64URL HELPERS
// ============================================================

function base64urlEncode(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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
// DER → RAW ECDSA SIGNATURE CONVERSION
// ============================================================

/**
 * Convert a DER-encoded ECDSA signature to raw r||s format (64 bytes).
 * Web Crypto may return DER; JWT ES256 expects raw concatenation.
 */
function derToRaw(der: Uint8Array): Uint8Array {
  if (der.length === 64) return der;
  if (der[0] !== 0x30) throw new Error('Invalid DER signature');

  let offset = 2;
  if (der[1] & 0x80) offset = 2 + (der[1] & 0x7f);

  // Parse r
  if (der[offset] !== 0x02) throw new Error('Invalid DER: expected INTEGER for r');
  offset++;
  const rLen = der[offset];
  offset++;
  let rStart = offset;
  if (rLen === 33 && der[rStart] === 0x00) rStart++;
  const r = der.slice(rStart, offset + rLen);
  offset += rLen;

  // Parse s
  if (der[offset] !== 0x02) throw new Error('Invalid DER: expected INTEGER for s');
  offset++;
  const sLen = der[offset];
  offset++;
  let sStart = offset;
  if (sLen === 33 && der[sStart] === 0x00) sStart++;
  const s = der.slice(sStart, offset + sLen);

  const raw = new Uint8Array(64);
  raw.set(r.slice(Math.max(0, r.length - 32)), 32 - Math.min(r.length, 32));
  raw.set(s.slice(Math.max(0, s.length - 32)), 64 - Math.min(s.length, 32));
  return raw;
}

// ============================================================
// VAPID (RFC 8292)
// ============================================================

/**
 * Import VAPID private key as CryptoKey for ECDSA signing.
 */
async function importVapidKeys(
  privateKeyBase64: string,
  publicKeyBase64: string,
): Promise<CryptoKey> {
  const privateKeyBytes = base64urlDecode(privateKeyBase64);
  const publicKeyBytes = base64urlDecode(publicKeyBase64);

  if (publicKeyBytes.length !== 65 || publicKeyBytes[0] !== 0x04) {
    throw new Error(`Invalid VAPID public key: expected 65 bytes uncompressed`);
  }
  if (privateKeyBytes.length !== 32) {
    throw new Error(`Invalid VAPID private key: expected 32 bytes`);
  }

  const x = base64urlEncode(publicKeyBytes.slice(1, 33));
  const y = base64urlEncode(publicKeyBytes.slice(33, 65));
  const d = base64urlEncode(privateKeyBytes);

  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x, y, d },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/**
 * Generate a VAPID Authorization header value.
 *
 * @param audience - Push service origin (e.g., https://fcm.googleapis.com)
 * @param subject - Contact URI (mailto: or https:)
 * @param privateKeyBase64 - Base64url-encoded ECDSA P-256 private key
 * @param publicKeyBase64 - Base64url-encoded ECDSA P-256 public key
 * @returns Authorization header value: "vapid t=<jwt>,k=<publicKey>"
 */
async function generateVapidAuth(
  audience: string,
  subject: string,
  privateKeyBase64: string,
  publicKeyBase64: string,
): Promise<string> {
  const signingKey = await importVapidKeys(privateKeyBase64, publicKeyBase64);

  const header = { typ: 'JWT', alg: 'ES256' };
  const headerB64 = base64urlEncode(
    new TextEncoder().encode(JSON.stringify(header)),
  );

  const now = Math.floor(Date.now() / 1000);
  const payload = { aud: audience, exp: now + 12 * 60 * 60, sub: subject };
  const payloadB64 = base64urlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signatureBuffer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signingKey,
    signingInput,
  );

  const rawSignature = derToRaw(new Uint8Array(signatureBuffer));
  const signatureB64 = base64urlEncode(rawSignature);

  return `vapid t=${headerB64}.${payloadB64}.${signatureB64},k=${publicKeyBase64}`;
}

// ============================================================
// HKDF-SHA-256
// ============================================================

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
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(derived);
}

// ============================================================
// RFC 8291 ENCRYPTION
// ============================================================

/**
 * Encrypt a push message payload per RFC 8291.
 *
 * @param payload - Plaintext message (JSON string)
 * @param p256dhKey - Subscriber's P-256 public key (base64url)
 * @param authSecret - Subscriber's auth secret (base64url, 16 bytes)
 * @returns Encrypted body and HTTP headers
 */
async function encryptPushPayload(
  payload: string,
  p256dhKey: string,
  authSecret: string,
): Promise<{ body: Uint8Array; headers: Record<string, string> }> {
  const subscriberPublicKeyBytes = base64urlDecode(p256dhKey);
  const authSecretBytes = base64urlDecode(authSecret);

  if (subscriberPublicKeyBytes.length !== 65) {
    throw new Error(`Invalid subscriber public key: expected 65 bytes`);
  }
  if (authSecretBytes.length !== 16) {
    throw new Error(`Invalid auth secret: expected 16 bytes`);
  }

  // Import subscriber's public key for ECDH
  const subscriberPublicKey = await crypto.subtle.importKey(
    'raw',
    subscriberPublicKeyBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  // Generate ephemeral ECDH key pair
  const ephemeralKeyPair = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;

  // Export ephemeral public key (65 bytes uncompressed)
  const ephemeralPublicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', ephemeralKeyPair.publicKey) as ArrayBuffer,
  );

  // ECDH key agreement
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: subscriberPublicKey } as SubtleCryptoDeriveKeyAlgorithm,
      ephemeralKeyPair.privateKey,
      256,
    ),
  );

  // Derive IKM: HKDF(auth_secret, shared_secret, "WebPush: info\0" || ua_pub || as_pub, 32)
  const keyInfoPrefix = new TextEncoder().encode('WebPush: info\0');
  const keyInfo = concat(
    keyInfoPrefix,
    subscriberPublicKeyBytes,
    ephemeralPublicKeyBytes,
  );
  const ikm = await hkdfSha256(authSecretBytes, sharedSecret, keyInfo, 32);

  // Random 16-byte salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Derive CEK (16 bytes) and nonce (12 bytes)
  const cekInfo = new TextEncoder().encode('Content-Encoding: aes128gcm\0');
  const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce\0');
  const cek = await hkdfSha256(salt, ikm, cekInfo, 16);
  const nonce = await hkdfSha256(salt, ikm, nonceInfo, 12);

  // Pad plaintext: content || \x02 (final record delimiter)
  const payloadBytes = new TextEncoder().encode(payload);
  const paddedPlaintext = new Uint8Array(payloadBytes.length + 1);
  paddedPlaintext.set(payloadBytes, 0);
  paddedPlaintext[payloadBytes.length] = 0x02;

  // AES-128-GCM encryption
  const cekKey = await crypto.subtle.importKey(
    'raw',
    cek,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const encryptedBytes = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      cekKey,
      paddedPlaintext,
    ),
  );

  // Build aes128gcm header: salt(16) || rs(4) || idlen(1) || keyid(65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  const idlen = new Uint8Array([ephemeralPublicKeyBytes.length]);
  const header = concat(salt, rs, idlen, ephemeralPublicKeyBytes);

  return {
    body: concat(header, encryptedBytes),
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
    },
  };
}

// ============================================================
// DISPATCH
// ============================================================

export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface PushResult {
  success: boolean;
  status: number;
  gone: boolean;
}

/**
 * Send a Web Push notification.
 *
 * @param subscription - Push subscription with endpoint and encryption keys
 * @param payload - JSON string payload to encrypt and deliver
 * @param vapidPrivateKey - Base64url VAPID private key
 * @param vapidPublicKey - Base64url VAPID public key
 * @param vapidSubject - Contact URI (mailto: or https:)
 */
export async function sendPushNotification(
  subscription: PushSubscription,
  payload: string,
  vapidPrivateKey: string,
  vapidPublicKey: string,
  vapidSubject: string,
): Promise<PushResult> {
  const audience = new URL(subscription.endpoint).origin;
  const authorization = await generateVapidAuth(
    audience,
    vapidSubject,
    vapidPrivateKey,
    vapidPublicKey,
  );

  const encrypted = await encryptPushPayload(
    payload,
    subscription.keys.p256dh,
    subscription.keys.auth,
  );

  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      ...encrypted.headers,
      Authorization: authorization,
      TTL: '86400',
      Urgency: 'normal',
    },
    body: encrypted.body,
  });

  const status = response.status;
  return {
    success: status >= 200 && status < 300,
    status,
    gone: status === 410 || status === 404,
  };
}
