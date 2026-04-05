/**
 * Fedify Federation Instance Factory (Queue Consumer)
 *
 * Creates a CACHED Fedify Federation instance for the queue consumer.
 * The Federation + dispatchers + listeners are registered ONCE per isolate,
 * not per message. This matches the worker's caching pattern.
 *
 * @see https://fedify.dev/
 */

import { createFederation, type Federation, type MessageQueue } from '@fedify/fedify';
import { WorkersKvStore, WorkersMessageQueue } from '@fedify/cfworkers';
import type { Env } from './env';

/**
 * Context data passed to all Fedify dispatchers and listeners.
 */
export interface FedifyContextData {
  env: Env;
}

/**
 * Wrapper around WorkersMessageQueue that makes listen() a no-op.
 */
class CloudflareMessageQueue implements MessageQueue {
  private inner: WorkersMessageQueue;

  constructor(queue: Queue) {
    this.inner = new WorkersMessageQueue(queue);
  }

  enqueue(message: unknown, options?: any): Promise<void> {
    return this.inner.enqueue(message, options);
  }

  async listen(
    _handler: (message: unknown) => Promise<void> | void,
    _options?: Record<string, unknown>,
  ): Promise<void> {
    // No-op: Workers use processQueuedTask() instead.
  }
}

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
    queue: new CloudflareMessageQueue(env.QUEUE_FEDERATION),
    userAgent: {
      software: 'SiliconBeest/1.0',
      url: new URL(`https://${env.INSTANCE_DOMAIN}/`),
    },
    // TODO: remove skipSignatureVerification for production
    // Matches the worker's setting — many remote servers trigger 401s due to
    // signer≠actor mismatches and unsupported signature algorithms. Fedify
    // still checks LD Signatures and Object Integrity Proofs with this on.
    skipSignatureVerification: true,
  });

  return cachedFed;
}
