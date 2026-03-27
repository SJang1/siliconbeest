/**
 * VAPID (Voluntary Application Server Identification) JWT generation
 *
 * Implements the VAPID protocol per RFC 8292 using Web Crypto API.
 * Generates signed JWTs with ECDSA P-256 (ES256) for authenticating
 * push message senders to push services.
 */

// ============================================================
// BASE64URL HELPERS
// ============================================================

export function base64urlEncode(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(str: string): Uint8Array {
  // Restore standard base64
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  // Pad to multiple of 4
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

// ============================================================
// KEY IMPORT
// ============================================================

/**
 * Import a VAPID private key from base64url-encoded raw 32-byte scalar.
 *
 * Web Crypto requires JWK format for ECDSA P-256 private keys when
 * importing from raw scalar bytes. We construct the JWK manually
 * using the raw private key (d) and derive x,y from the public key
 * if needed — but since we also have the public key available,
 * we import as JWK with d, x, y.
 */
export async function importVapidKeys(
  privateKeyBase64: string,
  publicKeyBase64: string,
): Promise<CryptoKey> {
  const privateKeyBytes = base64urlDecode(privateKeyBase64);
  const publicKeyBytes = base64urlDecode(publicKeyBase64);

  // The public key should be 65 bytes (uncompressed P-256: 0x04 + 32-byte x + 32-byte y)
  if (publicKeyBytes.length !== 65 || publicKeyBytes[0] !== 0x04) {
    throw new Error(
      `Invalid VAPID public key: expected 65 bytes uncompressed, got ${publicKeyBytes.length}`,
    );
  }
  if (privateKeyBytes.length !== 32) {
    throw new Error(
      `Invalid VAPID private key: expected 32 bytes, got ${privateKeyBytes.length}`,
    );
  }

  // Extract x and y coordinates from uncompressed public key
  const x = base64urlEncode(publicKeyBytes.slice(1, 33));
  const y = base64urlEncode(publicKeyBytes.slice(33, 65));
  const d = base64urlEncode(privateKeyBytes);

  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x,
    y,
    d,
  };

  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

// ============================================================
// VAPID JWT GENERATION
// ============================================================

/**
 * Generate a VAPID Authorization header value.
 *
 * @param audience - The origin of the push service (e.g., https://fcm.googleapis.com)
 * @param subject - Contact URI (mailto: or https:)
 * @param privateKeyBase64 - Base64url-encoded ECDSA P-256 private key (32 bytes)
 * @param publicKeyBase64 - Base64url-encoded ECDSA P-256 public key (65 bytes uncompressed)
 * @returns Authorization header value: "vapid t=<jwt>,k=<publicKey>"
 */
export async function generateVapidAuth(
  audience: string,
  subject: string,
  privateKeyBase64: string,
  publicKeyBase64: string,
): Promise<string> {
  const signingKey = await importVapidKeys(privateKeyBase64, publicKeyBase64);

  // JWT Header
  const header = { typ: 'JWT', alg: 'ES256' };
  const headerB64 = base64urlEncode(
    new TextEncoder().encode(JSON.stringify(header)),
  );

  // JWT Payload — expires in 12 hours
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: audience,
    exp: now + 12 * 60 * 60,
    sub: subject,
  };
  const payloadB64 = base64urlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );

  // Signing input
  const signingInput = `${headerB64}.${payloadB64}`;
  const signingInputBytes = new TextEncoder().encode(signingInput);

  // Sign with ECDSA P-256 SHA-256
  const signatureBuffer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signingKey,
    signingInputBytes,
  );

  // Web Crypto produces a DER-encoded signature for ECDSA.
  // JWT ES256 expects raw r||s (64 bytes). Convert if needed.
  const signatureBytes = new Uint8Array(signatureBuffer);
  const rawSignature = derToRaw(signatureBytes);
  const signatureB64 = base64urlEncode(rawSignature);

  const jwt = `${headerB64}.${payloadB64}.${signatureB64}`;

  return `vapid t=${jwt},k=${publicKeyBase64}`;
}

// ============================================================
// DER → RAW SIGNATURE CONVERSION
// ============================================================

/**
 * Convert a DER-encoded ECDSA signature to raw r||s format (64 bytes).
 *
 * Web Crypto's ECDSA sign() returns DER format:
 *   SEQUENCE { INTEGER r, INTEGER s }
 *
 * JWT ES256 expects the raw concatenation: r (32 bytes) || s (32 bytes)
 */
function derToRaw(der: Uint8Array): Uint8Array {
  // If it's already 64 bytes, assume it's raw format
  if (der.length === 64) {
    return der;
  }

  // Parse DER SEQUENCE
  if (der[0] !== 0x30) {
    throw new Error('Invalid DER signature: expected SEQUENCE tag');
  }

  let offset = 2; // Skip SEQUENCE tag and length

  // Handle multi-byte length
  if (der[1] & 0x80) {
    const lenBytes = der[1] & 0x7f;
    offset = 2 + lenBytes;
  }

  // Parse r INTEGER
  if (der[offset] !== 0x02) {
    throw new Error('Invalid DER signature: expected INTEGER tag for r');
  }
  offset++;
  const rLen = der[offset];
  offset++;
  let rStart = offset;
  // Skip leading zero padding (DER integers are signed, may have 0x00 prefix)
  if (rLen === 33 && der[rStart] === 0x00) {
    rStart++;
  }
  const r = der.slice(rStart, offset + rLen);
  offset += rLen;

  // Parse s INTEGER
  if (der[offset] !== 0x02) {
    throw new Error('Invalid DER signature: expected INTEGER tag for s');
  }
  offset++;
  const sLen = der[offset];
  offset++;
  let sStart = offset;
  if (sLen === 33 && der[sStart] === 0x00) {
    sStart++;
  }
  const s = der.slice(sStart, offset + sLen);

  // Pad r and s to 32 bytes each
  const raw = new Uint8Array(64);
  raw.set(r.slice(Math.max(0, r.length - 32)), 32 - Math.min(r.length, 32));
  raw.set(s.slice(Math.max(0, s.length - 32)), 64 - Math.min(s.length, 32));

  return raw;
}
