/**
 * Fedify Federation Instance Factory
 *
 * Creates a cached Fedify Federation instance for Cloudflare Workers.
 * The Federation and all dispatchers/listeners are registered ONCE per
 * isolate, not per request. Only the waitUntil function changes per request.
 */

import { createFederation, type Federation } from '@fedify/fedify';
import { WorkersKvStore, WorkersMessageQueue } from '@fedify/cfworkers';
import { env } from 'cloudflare:workers';

/** Context data passed to Fedify dispatchers. Empty — use import { env } instead. */
export interface FedifyContextData {}

/** Cached Federation instance (lives for the isolate lifetime) */
let cachedFed: Federation<FedifyContextData> | null = null;

function shouldSkipSignatureVerification(configuredValue: boolean): boolean {
  return configuredValue === true;
}

/**
 * Get or create a cached Fedify Federation instance.
 */
export function createFed(): Federation<FedifyContextData> {
  if (cachedFed) return cachedFed;

  cachedFed = createFederation<FedifyContextData>({
    kv: new WorkersKvStore(env.FEDIFY_KV),
    queue: {
      inbox: new WorkersMessageQueue(env.QUEUE_INBOX, { orderingKv: env.FEDIFY_KV }),
      outbox: new WorkersMessageQueue(env.QUEUE_FEDERATION, { orderingKv: env.FEDIFY_KV }),
    },
    userAgent: {
      software: 'SiliconBeest/1.0',
      url: new URL(`https://${env.INSTANCE_DOMAIN}/`),
    },
    skipSignatureVerification: shouldSkipSignatureVerification(
      env.SKIP_SIGNATURE_VERIFICATION,
    ),
  });

  return cachedFed;
}
