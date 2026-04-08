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

/**
 * Get or create a cached Fedify Federation instance.
 */
export function createFed(): Federation<FedifyContextData> {
  if (cachedFed) return cachedFed;

  cachedFed = createFederation<FedifyContextData>({
    // @ts-expect-error — @fedify/cfworkers imports KVNamespace from @cloudflare/workers-types; wrangler/vite generates its own nominal KVNamespace
    kv: new WorkersKvStore(env.FEDIFY_KV),
    queue: new WorkersMessageQueue(env.QUEUE_FEDERATION),
    userAgent: {
      software: 'SiliconBeest/1.0',
      url: new URL(`https://${env.INSTANCE_DOMAIN}/`),
    },
    skipSignatureVerification: env.SKIP_SIGNATURE_VERIFICATION === 'true',
  });

  return cachedFed;
}
