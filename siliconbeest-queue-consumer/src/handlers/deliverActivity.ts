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
import { measureAsync, PerfTimer } from '../observability/performance';

// Crypto and signing utilities from shared package (consolidates previously duplicated code)
import { signRequestCavage, signRequestRFC9421 } from '../../../packages/shared/crypto';

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
  const targetDomain = new URL(inboxUrl).hostname;
  const timer = new PerfTimer('deliverActivity.total', { inboxUrl, targetDomain });
  timer.start();

  // Load the actor's private key, Ed25519 key, and URI from D1
  const keyRow = await measureAsync(
    'deliverActivity.db.loadActorKey',
    () => env.DB.prepare(
      `SELECT ak.private_key, ak.ed25519_private_key, a.uri
       FROM actor_keys ak
       JOIN accounts a ON a.id = ak.account_id
       WHERE ak.account_id = ?`,
    )
      .bind(actorAccountId)
      .first<{ private_key: string; ed25519_private_key: string | null; uri: string }>(),
    { actorAccountId }
  );

  if (!keyRow) {
    console.error(`No private key found for actor ${actorAccountId}, dropping message`);
    timer.stopWithMetadata({ status: 'no_key' });
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
      activityToDeliver = await measureAsync(
        'deliverActivity.createIntegrityProof',
        () => createProof(activityToDeliver, keyRow.ed25519_private_key!, ed25519KeyId),
        { targetDomain }
      );
    } catch (e) {
      console.warn(`Failed to create integrity proof for activity, delivering without proof:`, e);
    }
  }

  // Linked Data Signatures (LDS) are an older standard and no longer needed.
  // We rely on Object Integrity Proofs (FEP-8b32) and HTTP Signatures.

  const body = JSON.stringify(activityToDeliver);

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
    const headers = await measureAsync(
      'deliverActivity.signRequestCavage',
      () => signRequestCavage(keyRow.private_key, keyId, inboxUrl, 'POST', body),
      { targetDomain, signatureType: 'cavage' }
    );
    response = await measureAsync(
      'deliverActivity.fetch',
      () => fetch(inboxUrl, {
        method: 'POST',
        headers: {
          ...headers,
          'User-Agent': 'SiliconBeest/1.0 (ActivityPub; +https://github.com/SJang1/siliconbeest)',
        },
        body
      }),
      { targetDomain, signatureType: 'cavage', attempt: 1 }
    );

    // If cavage fails with 401/403, try RFC 9421 as fallback
    if (response.status === 401 || response.status === 403) {
      console.log(
        `[deliver] draft-cavage rejected by ${targetDomain} (${response.status}), falling back to RFC 9421`,
      );
      const rfc9421Headers = await measureAsync(
        'deliverActivity.signRequestRFC9421',
        () => signRequestRFC9421(keyRow.private_key, keyId, inboxUrl, 'POST', body),
        { targetDomain, signatureType: 'rfc9421', fallback: true }
      );
      response = await measureAsync(
        'deliverActivity.fetch',
        () => fetch(inboxUrl, {
          method: 'POST',
          headers: {
            ...rfc9421Headers,
            'User-Agent': 'SiliconBeest/1.0 (ActivityPub; +https://github.com/SJang1/siliconbeest)',
          },
          body
        }),
        { targetDomain, signatureType: 'rfc9421', attempt: 2, fallback: true }
      );

      if (response.ok || response.status === 202) {
        // RFC 9421 worked — update cached preference
        await setSignaturePreference(targetDomain, 'rfc9421', env.CACHE);
      }
    }
  } else {
    // Try RFC 9421 first (default or known to support it)
    const rfc9421Headers = await measureAsync(
      'deliverActivity.signRequestRFC9421',
      () => signRequestRFC9421(keyRow.private_key, keyId, inboxUrl, 'POST', body),
      { targetDomain, signatureType: 'rfc9421' }
    );
    response = await measureAsync(
      'deliverActivity.fetch',
      () => fetch(inboxUrl, {
        method: 'POST',
        headers: {
          ...rfc9421Headers,
          'User-Agent': 'SiliconBeest/1.0 (ActivityPub; +https://github.com/SJang1/siliconbeest)',
        },
        body
      }),
      { targetDomain, signatureType: 'rfc9421', attempt: 1 }
    );

    if (response.status === 401 || response.status === 403) {
      // RFC 9421 rejected — fall back to draft-cavage
      console.log(
        `[deliver] RFC 9421 rejected by ${targetDomain} (${response.status}), falling back to draft-cavage`,
      );
      const cavageHeaders = await measureAsync(
        'deliverActivity.signRequestCavage',
        () => signRequestCavage(keyRow.private_key, keyId, inboxUrl, 'POST', body),
        { targetDomain, signatureType: 'cavage', fallback: true }
      );
      response = await measureAsync(
        'deliverActivity.fetch',
        () => fetch(inboxUrl, {
          method: 'POST',
          headers: {
            ...cavageHeaders,
            'User-Agent': 'SiliconBeest/1.0 (ActivityPub; +https://github.com/SJang1/siliconbeest)',
          },
          body
        }),
        { targetDomain, signatureType: 'cavage', attempt: 2, fallback: true }
      );

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
    timer.stopWithMetadata({ status: 'success', httpStatus: response.status });
    return;
  }

  if (response.status >= 500) {
    // Record failure
    await env.DB.prepare(
      `UPDATE instances SET last_failed_at = datetime('now'), failure_count = failure_count + 1, updated_at = datetime('now') WHERE domain = ?`,
    )
      .bind(targetDomain)
      .run();

    timer.stopWithMetadata({ status: 'server_error', httpStatus: response.status });
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
  timer.stopWithMetadata({ status: 'client_error', httpStatus: response.status });
  const text = await response.text().catch(() => '');
  console.warn(
    `Delivery to ${inboxUrl} rejected with ${response.status}: ${text.slice(0, 200)}`,
  );
}
