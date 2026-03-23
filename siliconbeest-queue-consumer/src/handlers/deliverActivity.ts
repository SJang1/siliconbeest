/**
 * Deliver Activity Handler
 *
 * Signs an ActivityPub activity with the actor's RSA private key
 * and POSTs it to the target inbox URL.
 *
 * HTTP Signature implementation follows draft-cavage-http-signatures
 * using RSASSA-PKCS1-v1_5 SHA-256 via the Web Crypto API.
 */

import type { Env } from '../env';
import type { DeliverActivityMessage } from '../shared/types/queue';

// ============================================================
// PEM / CRYPTO HELPERS
// ============================================================

/**
 * Strip PEM headers/footers and base64-decode the key material.
 */
function parsePemKey(pem: string): ArrayBuffer {
  const lines = pem
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\r?\n/g, '')
    .trim();
  const binaryString = atob(lines);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Import a PKCS8-encoded PEM private key for RSASSA-PKCS1-v1_5 SHA-256 signing.
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const keyData = parsePemKey(pem);
  return crypto.subtle.importKey(
    'pkcs8',
    keyData,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: { name: 'SHA-256' },
    },
    false,
    ['sign'],
  );
}

/**
 * Compute SHA-256 digest in the `SHA-256=base64(...)` format.
 */
async function computeDigest(body: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(body);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashBytes = new Uint8Array(hashBuffer);
  let binary = '';
  for (const byte of hashBytes) {
    binary += String.fromCharCode(byte);
  }
  return `SHA-256=${btoa(binary)}`;
}

/**
 * Sign an outgoing HTTP request for ActivityPub delivery.
 *
 * Builds a signing string from (request-target), host, date, digest,
 * and content-type. Signs with RSASSA-PKCS1-v1_5 SHA-256.
 */
async function signRequest(
  privateKeyPem: string,
  keyId: string,
  url: string,
  body: string,
): Promise<Record<string, string>> {
  const parsedUrl = new URL(url);
  const date = new Date().toUTCString();
  const host = parsedUrl.host;
  const requestTarget = `post ${parsedUrl.pathname}${parsedUrl.search}`;

  const digest = await computeDigest(body);

  const signedHeaderNames = ['(request-target)', 'host', 'date', 'digest', 'content-type'];
  const signingParts = [
    `(request-target): ${requestTarget}`,
    `host: ${host}`,
    `date: ${date}`,
    `digest: ${digest}`,
    `content-type: application/activity+json`,
  ];
  const signingString = signingParts.join('\n');

  // Sign with RSA
  const privateKey = await importPrivateKey(privateKeyPem);
  const encoder = new TextEncoder();
  const signatureBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    encoder.encode(signingString),
  );
  const signatureBytes = new Uint8Array(signatureBuffer);
  let signatureBinary = '';
  for (const byte of signatureBytes) {
    signatureBinary += String.fromCharCode(byte);
  }
  const signatureBase64 = btoa(signatureBinary);

  const signatureHeader =
    `keyId="${keyId}",algorithm="rsa-sha256",headers="${signedHeaderNames.join(' ')}",signature="${signatureBase64}"`;

  return {
    Host: host,
    Date: date,
    Digest: digest,
    'Content-Type': 'application/activity+json',
    Signature: signatureHeader,
  };
}

// ============================================================
// HANDLER
// ============================================================

export async function handleDeliverActivity(
  msg: DeliverActivityMessage,
  env: Env,
): Promise<void> {
  const { activity, inboxUrl, actorAccountId } = msg;

  // Load the actor's private key and key ID from D1
  const keyRow = await env.DB.prepare(
    `SELECT ak.private_key_pem, a.uri
     FROM actor_keys ak
     JOIN accounts a ON a.id = ak.account_id
     WHERE ak.account_id = ?`,
  )
    .bind(actorAccountId)
    .first<{ private_key_pem: string; uri: string }>();

  if (!keyRow) {
    console.error(`No private key found for actor ${actorAccountId}, dropping message`);
    return; // consume the message — can't deliver without a key
  }

  const keyId = `${keyRow.uri}#main-key`;
  const body = JSON.stringify(activity);

  // Sign the request
  const headers = await signRequest(keyRow.private_key_pem, keyId, inboxUrl, body);

  // POST to target inbox
  const response = await fetch(inboxUrl, {
    method: 'POST',
    headers,
    body,
  });

  const targetDomain = new URL(inboxUrl).hostname;

  if (response.ok || response.status === 202) {
    // Success — update last_successful_at for the target instance
    await env.DB.prepare(
      `UPDATE instances SET last_successful_at = datetime('now') WHERE domain = ?`,
    )
      .bind(targetDomain)
      .run();
    console.log(`Delivered activity to ${inboxUrl} (${response.status})`);
    return;
  }

  if (response.status >= 500) {
    // Server error — throw to trigger queue retry
    const text = await response.text().catch(() => '');
    throw new Error(
      `Delivery to ${inboxUrl} failed with ${response.status}: ${text.slice(0, 200)}`,
    );
  }

  // 4xx — client error, don't retry (the message is consumed)
  const text = await response.text().catch(() => '');
  console.warn(
    `Delivery to ${inboxUrl} rejected with ${response.status}: ${text.slice(0, 200)}`,
  );
}
