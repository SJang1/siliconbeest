/**
 * Fedify Federation Instance Factory (Queue Consumer)
 *
 * Creates a CACHED Fedify Federation instance for the queue consumer.
 * The Federation + dispatchers + listeners are registered ONCE per isolate.
 */

import { createFederation, type Federation } from '@fedify/fedify';
import { WorkersKvStore, WorkersMessageQueue } from '@fedify/cfworkers';
import { env } from 'cloudflare:workers';
import { CloudflareMessageQueue } from '../../packages/shared/fedify/cloudflare-queue';

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
    // @ts-expect-error — @fedify/cfworkers uses @cloudflare/workers-types/experimental internally
    kv: new WorkersKvStore(env.FEDIFY_KV),
    // @ts-expect-error — same wrangler vs experimental type mismatch
    queue: new CloudflareMessageQueue(new WorkersMessageQueue(env.QUEUE_FEDERATION)),
    userAgent: {
      software: 'SiliconBeest/1.0',
      url: new URL(`https://${env.INSTANCE_DOMAIN}/`),
    },
    skipSignatureVerification: env.SKIP_SIGNATURE_VERIFICATION === 'true',
  });

  return cachedFed;
}
