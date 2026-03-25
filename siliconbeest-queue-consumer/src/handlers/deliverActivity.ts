/**
 * Deliver Activity Handler
 *
 * Signs an ActivityPub activity with the actor's RSA private key
 * and POSTs it to the target inbox URL.
 *
 * Implements a "double-knock" strategy: try RFC 9421 first, fall back
 * to draft-cavage if the recipient rejects it, and remember the
 * recipient's preference in KV cache for 7 days.
 *
 * HTTP Signature implementations:
 *   - RFC 9421 HTTP Message Signatures (preferred)
 *   - draft-cavage-http-signatures (fallback)
 * Both use RSASSA-PKCS1-v1_5 SHA-256 via the Web Crypto API.
 */

import type { Env } from '../env';
import type { DeliverActivityMessage } from '../shared/types/queue';
import { createProof } from './integrityProofs';
import { addLDSignature } from './ldSignatures';

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
 * Helper to encode bytes to base64.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Compute SHA-256 digest in the `SHA-256=base64(...)` format (draft-cavage Digest header).
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
 * Compute Content-Digest per RFC 9530.
 * Format: `sha-256=:BASE64:` (structured field byte sequence)
 */
async function computeContentDigest(body: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(body);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashBytes = new Uint8Array(hashBuffer);
  let binary = '';
  for (const byte of hashBytes) {
    binary += String.fromCharCode(byte);
  }
  return `sha-256=:${btoa(binary)}:`;
}

// ============================================================
// DRAFT-CAVAGE SIGNING
// ============================================================

/**
 * Sign an outgoing HTTP request using draft-cavage-http-signatures.
 */
async function signRequestCavage(
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
  const signatureBase64 = bytesToBase64(new Uint8Array(signatureBuffer));

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
// RFC 9421 SIGNING
// ============================================================

/**
 * Sign an outgoing HTTP request using RFC 9421 HTTP Message Signatures.
 *
 * Uses derived components (@method, @target-uri, @authority) and
 * Content-Digest / Content-Type headers. Produces `Signature-Input`
 * and `Signature` headers in structured field format.
 */
async function signRequestRFC9421(
  privateKeyPem: string,
  keyId: string,
  url: string,
  body: string,
): Promise<Record<string, string>> {
  const parsedUrl = new URL(url);
  const date = new Date().toUTCString();
  const created = Math.floor(Date.now() / 1000);

  const contentDigest = await computeContentDigest(body);

  // Components to sign
  const components = ['@method', '@target-uri', '@authority', 'content-digest', 'content-type'];
  const componentValues: Record<string, string> = {
    '@method': 'POST',
    '@target-uri': url,
    '@authority': parsedUrl.host,
    'content-digest': contentDigest,
    'content-type': 'application/activity+json',
  };

  // Build the signature-params value
  const componentList = components.map((c) => `"${c}"`).join(' ');
  const signatureParamsValue = `(${componentList});created=${created};keyid="${keyId}";alg="rsa-v1_5-sha256"`;

  // Build the signature base
  const lines: string[] = [];
  for (const component of components) {
    lines.push(`"${component}": ${componentValues[component]}`);
  }
  lines.push(`"@signature-params": ${signatureParamsValue}`);
  const signatureBase = lines.join('\n');

  // Sign with RSA
  const privateKey = await importPrivateKey(privateKeyPem);
  const encoder = new TextEncoder();
  const signatureBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    encoder.encode(signatureBase),
  );
  const signatureBase64 = bytesToBase64(new Uint8Array(signatureBuffer));

  return {
    Host: parsedUrl.host,
    Date: date,
    'Content-Digest': contentDigest,
    'Content-Type': 'application/activity+json',
    'Signature-Input': `sig1=${signatureParamsValue}`,
    Signature: `sig1=:${signatureBase64}:`,
  };
}

// ============================================================
// SIGNATURE PREFERENCE CACHE
// ============================================================

type SignaturePreference = 'rfc9421' | 'cavage';

const SIG_PREF_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

async function getSignaturePreference(
  domain: string,
  cache: KVNamespace,
): Promise<SignaturePreference | null> {
  const value = await cache.get(`sig-pref:${domain}`);
  if (value === 'rfc9421' || value === 'cavage') return value;
  return null;
}

async function setSignaturePreference(
  domain: string,
  pref: SignaturePreference,
  cache: KVNamespace,
): Promise<void> {
  try { await cache.put(`sig-pref:${domain}`, pref, { expirationTtl: SIG_PREF_TTL }); } catch { /* KV rate limit */ }
}

// ============================================================
// HANDLER
// ============================================================

export async function handleDeliverActivity(
  msg: DeliverActivityMessage,
  env: Env,
): Promise<void> {
  const { activity, inboxUrl, actorAccountId } = msg;

  // Load the actor's private key, Ed25519 key, and URI from D1
  const keyRow = await env.DB.prepare(
    `SELECT ak.private_key, ak.ed25519_private_key, a.uri
     FROM actor_keys ak
     JOIN accounts a ON a.id = ak.account_id
     WHERE ak.account_id = ?`,
  )
    .bind(actorAccountId)
    .first<{ private_key: string; ed25519_private_key: string | null; uri: string }>();

  if (!keyRow) {
    console.error(`No private key found for actor ${actorAccountId}, dropping message`);
    return; // consume the message — can't deliver without a key
  }

  const keyId = `${keyRow.uri}#main-key`;

  // Attach Object Integrity Proof (FEP-8b32) FIRST if Ed25519 key is available.
  // This must happen before LD signature because createProof may modify @context
  // (adding the data-integrity context), and the LD signature must be computed
  // over the final document including any @context changes.
  let activityToDeliver = activity as Record<string, unknown>;
  if (keyRow.ed25519_private_key) {
    try {
      const ed25519KeyId = `${keyRow.uri}#ed25519-key`;
      activityToDeliver = await createProof(
        activityToDeliver,
        keyRow.ed25519_private_key,
        ed25519KeyId,
      );
    } catch (e) {
      console.warn(`Failed to create integrity proof for activity, delivering without proof:`, e);
    }
  }

  // Attach Linked Data Signature (RsaSignature2017) AFTER integrity proof.
  // The LD signature hashes the document without the `signature` field but
  // WITH the `proof` and updated `@context`, so verifiers see consistent data.
  try {
    activityToDeliver = await addLDSignature(activityToDeliver, keyRow.private_key, keyId);
  } catch (e) {
    console.warn(`Failed to create LD signature for activity, delivering without:`, e);
  }

  const body = JSON.stringify(activityToDeliver);
  const targetDomain = new URL(inboxUrl).hostname;

  // Ensure instance record exists before updating it
  await env.DB.prepare(
    `INSERT OR IGNORE INTO instances (id, domain, created_at, updated_at)
     VALUES (?, ?, datetime('now'), datetime('now'))`,
  )
    .bind(crypto.randomUUID(), targetDomain)
    .run();

  // Check cached signature preference for this domain
  const preference = await getSignaturePreference(targetDomain, env.CACHE);

  let response: Response;

  if (preference === 'cavage') {
    // Domain is known to prefer draft-cavage — try it first
    const headers = await signRequestCavage(keyRow.private_key, keyId, inboxUrl, body);
    response = await fetch(inboxUrl, { method: 'POST', headers, body });

    // If cavage fails with 401/403, try RFC 9421 as fallback
    if (response.status === 401 || response.status === 403) {
      console.log(
        `[deliver] draft-cavage rejected by ${targetDomain} (${response.status}), falling back to RFC 9421`,
      );
      const rfc9421Headers = await signRequestRFC9421(keyRow.private_key, keyId, inboxUrl, body);
      response = await fetch(inboxUrl, { method: 'POST', headers: rfc9421Headers, body });

      if (response.ok || response.status === 202) {
        // RFC 9421 worked — update cached preference
        await setSignaturePreference(targetDomain, 'rfc9421', env.CACHE);
      }
    }
  } else {
    // Try RFC 9421 first (default or known to support it)
    const rfc9421Headers = await signRequestRFC9421(keyRow.private_key, keyId, inboxUrl, body);
    response = await fetch(inboxUrl, { method: 'POST', headers: rfc9421Headers, body });

    if (response.status === 401 || response.status === 403) {
      // RFC 9421 rejected — fall back to draft-cavage
      console.log(
        `[deliver] RFC 9421 rejected by ${targetDomain} (${response.status}), falling back to draft-cavage`,
      );
      const cavageHeaders = await signRequestCavage(keyRow.private_key, keyId, inboxUrl, body);
      response = await fetch(inboxUrl, { method: 'POST', headers: cavageHeaders, body });

      if (response.ok || response.status === 202) {
        // Draft-cavage worked — remember this preference
        await setSignaturePreference(targetDomain, 'cavage', env.CACHE);
      }
    } else if (response.ok || response.status === 202) {
      // RFC 9421 accepted — remember this preference (only if we didn't already know)
      if (preference !== 'rfc9421') {
        await setSignaturePreference(targetDomain, 'rfc9421', env.CACHE);
      }
    }
  }

  if (response.ok || response.status === 202) {
    // Success — reset failure count and update last_successful_at
    await env.DB.prepare(
      `UPDATE instances SET last_successful_at = datetime('now'), failure_count = 0, updated_at = datetime('now') WHERE domain = ?`,
    )
      .bind(targetDomain)
      .run();
    console.log(`Delivered activity to ${inboxUrl} (${response.status})`);
    return;
  }

  if (response.status >= 500) {
    // Record failure
    await env.DB.prepare(
      `UPDATE instances SET last_failed_at = datetime('now'), failure_count = failure_count + 1, updated_at = datetime('now') WHERE domain = ?`,
    )
      .bind(targetDomain)
      .run();

    // All 5xx (including SSL errors 525-527) — throw to trigger queue retry
    const text = await response.text().catch(() => '');
    throw new Error(
      `Delivery to ${inboxUrl} failed with ${response.status}: ${text.slice(0, 200)}`,
    );
  }

  // 4xx — client error, record failure but don't retry (the message is consumed)
  await env.DB.prepare(
    `UPDATE instances SET last_failed_at = datetime('now'), failure_count = failure_count + 1, updated_at = datetime('now') WHERE domain = ?`,
  )
    .bind(targetDomain)
    .run();
  const text = await response.text().catch(() => '');
  console.warn(
    `Delivery to ${inboxUrl} rejected with ${response.status}: ${text.slice(0, 200)}`,
  );
}
