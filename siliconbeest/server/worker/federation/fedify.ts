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
import { CloudflareMessageQueue } from '../../../../packages/shared/fedify/cloudflare-queue';

/** Context data passed to Fedify dispatchers. Empty — use import { env } instead. */
export interface FedifyContextData {}

/** Cached Federation instance (lives for the isolate lifetime) */
let cachedFed: Federation<FedifyContextData> | null = null;
/** Cached queue wrapper (for per-request waitUntil updates) */
let cachedQueue: CloudflareMessageQueue | null = null;

/**
 * Get or create a cached Fedify Federation instance.
 */
export function createFed(): Federation<FedifyContextData> {
  if (cachedFed) return cachedFed;

  // @ts-expect-error — @fedify/cfworkers uses @cloudflare/workers-types/experimental internally
  cachedQueue = new CloudflareMessageQueue(new WorkersMessageQueue(env.QUEUE_FEDERATION));

  cachedFed = createFederation<FedifyContextData>({
    // @ts-expect-error — same wrangler vs experimental type mismatch
    kv: new WorkersKvStore(env.FEDIFY_KV),
    queue: cachedQueue,
    userAgent: {
      software: 'SiliconBeest/1.0',
      url: new URL(`https://${env.INSTANCE_DOMAIN}/`),
    },
    skipSignatureVerification: env.SKIP_SIGNATURE_VERIFICATION === 'true',
  });

  return cachedFed;
}

/**
 * Update the per-request waitUntil function on the cached queue.
 */
export function setWaitUntil(fn: (promise: Promise<unknown>) => void): void {
  if (cachedQueue) {
    cachedQueue.setWaitUntilFn(fn);
  }
}
