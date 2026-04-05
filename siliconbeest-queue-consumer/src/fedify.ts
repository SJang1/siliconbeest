/**
 * Fedify Federation Instance Factory (Queue Consumer)
 *
 * Creates a CACHED Fedify Federation instance for the queue consumer.
 * The Federation + dispatchers + listeners are registered ONCE per isolate,
 * not per message. This matches the worker's caching pattern.
 *
 * @see https://fedify.dev/
 */

import { createFederation, type Federation } from '@fedify/fedify';
import { WorkersKvStore, WorkersMessageQueue } from '@fedify/cfworkers';
import type { Env } from './env';
import { CloudflareMessageQueue } from '../../packages/shared/fedify/cloudflare-queue';
import type { FedifyContextData as SharedFedifyContextData } from '../../packages/shared/fedify/context';

/**
 * Context data passed to all Fedify dispatchers and listeners.
 * Local alias of the shared generic, bound to the consumer's Env.
 */
export type FedifyContextData = SharedFedifyContextData<Env>;

/** Cached Federation instance (lives for the isolate lifetime) */
let cachedFed: Federation<FedifyContextData> | null = null;

/**
 * Get or create a cached Fedify Federation instance.
 * Created once per isolate, reused across all queue messages.
 */
export function createFed(env: Env): Federation<FedifyContextData> {
  if (cachedFed) return cachedFed;

  cachedFed = createFederation<FedifyContextData>({
    kv: new WorkersKvStore(env.FEDIFY_KV as unknown as import('@cloudflare/workers-types/experimental').KVNamespace),
    queue: new CloudflareMessageQueue(new WorkersMessageQueue(env.QUEUE_FEDERATION)),
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
