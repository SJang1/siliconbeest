/**
 * Fedify Federation Instance Factory
 *
 * Creates a cached Fedify Federation instance for Cloudflare Workers.
 * The Federation and all dispatchers/listeners are registered ONCE per
 * isolate, not per request. Only the waitUntil function and context data
 * (env) change per request.
 *
 * @see https://fedify.dev/
 * @see https://github.com/fedify-dev/fedify
 */

import { createFederation, type Federation } from '@fedify/fedify';
import { WorkersKvStore, WorkersMessageQueue } from '@fedify/cfworkers';
import type { Env } from '../env';
import { CloudflareMessageQueue } from '../../../../packages/shared/fedify/cloudflare-queue';
import type { FedifyContextData as SharedFedifyContextData } from '../../../../packages/shared/fedify/context';

/**
 * Context data passed to all Fedify dispatchers and listeners.
 * Provides access to Cloudflare Workers environment bindings.
 * Local alias of the shared generic, bound to the worker's Env.
 */
export type FedifyContextData = SharedFedifyContextData<Env>;

/** Cached Federation instance (lives for the isolate lifetime) */
let cachedFed: Federation<FedifyContextData> | null = null;
/** Cached queue wrapper (for per-request waitUntil updates) */
let cachedQueue: CloudflareMessageQueue | null = null;

/**
 * Get or create a cached Fedify Federation instance.
 *
 * The Federation + dispatchers + listeners are registered ONCE and reused
 * across all requests within the same Workers isolate. This avoids the
 * overhead of recreating everything on every request.
 *
 * @param env Cloudflare Workers Env bindings (used on first call to create the instance)
 * @returns Cached Federation instance
 */
export function createFed(
  env: Env,
): Federation<FedifyContextData> {
  if (cachedFed) return cachedFed;

  cachedQueue = new CloudflareMessageQueue(new WorkersMessageQueue(env.QUEUE_FEDERATION));

  cachedFed = createFederation<FedifyContextData>({
    kv: new WorkersKvStore(env.FEDIFY_KV as unknown as import('@cloudflare/workers-types/experimental').KVNamespace),
    queue: cachedQueue,
    userAgent: {
      software: 'SiliconBeest/1.0',
      url: new URL(`https://${env.INSTANCE_DOMAIN}/`),
    },
    // Controlled by SKIP_SIGNATURE_VERIFICATION env var (wrangler.jsonc vars).
    // When "true", Fedify skips HTTP Signature verification but still checks
    // LD Signatures and Object Integrity Proofs.
    skipSignatureVerification: env.SKIP_SIGNATURE_VERIFICATION === 'true',
  });

  return cachedFed;
}

/**
 * Update the per-request waitUntil function on the cached queue.
 *
 * Must be called at the start of each request so that fire-and-forget
 * enqueue Promises are kept alive until completion.
 */
export function setWaitUntil(fn: (promise: Promise<unknown>) => void): void {
  if (cachedQueue) {
    cachedQueue.setWaitUntilFn(fn);
  }
}
