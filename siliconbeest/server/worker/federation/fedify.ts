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

import { createFederation, type Federation, type MessageQueue } from '@fedify/fedify';
import { WorkersKvStore, WorkersMessageQueue } from '@fedify/cfworkers';
import type { Env } from '../env';

/**
 * Context data passed to all Fedify dispatchers and listeners.
 * Provides access to Cloudflare Workers environment bindings.
 */
export interface FedifyContextData {
  /** Cloudflare Workers environment bindings (D1, R2, KV, Queues, etc.) */
  env: Env;
}

/**
 * Wrapper around WorkersMessageQueue for Cloudflare Workers compatibility.
 *
 * Two critical fixes:
 *
 * 1. listen() is a no-op — WorkersMessageQueue.listen() throws by design
 *    because Cloudflare Workers use processQueuedTask() in the queue consumer.
 *    Fedify's sendActivity() calls listen() internally as a side-effect.
 *
 * 2. enqueue() uses ctx.waitUntil() — Fedify's sendActivity() calls
 *    fanoutQueue.enqueue() WITHOUT await (fire-and-forget). In Cloudflare
 *    Workers, un-awaited Promises are killed when the response is sent.
 *    We register each enqueue Promise with waitUntil() so the Worker
 *    keeps running until the queue.send() actually completes.
 */
class CloudflareMessageQueue implements MessageQueue {
  private inner: WorkersMessageQueue;
  /** Mutable — updated per-request via setWaitUntil() */
  waitUntilFn: ((promise: Promise<unknown>) => void) | null = null;

  constructor(queue: Queue) {
    this.inner = new WorkersMessageQueue(queue);
  }

  enqueue(
    message: any,
    options?: any,
  ): Promise<void> {
    const promise = this.inner.enqueue(message, options)
      .catch((err: unknown) => {
        console.error(`[queue-wrapper] enqueue FAILED, type=${message?.type}:`, err);
        throw err;
      });
    // Register with waitUntil so Cloudflare doesn't kill the Worker
    // before the queue.send() completes (Fedify doesn't await fanout enqueue)
    if (this.waitUntilFn) {
      this.waitUntilFn(promise);
    }
    return promise;
  }

  async listen(
    _handler: (message: any) => Promise<void> | void,
    _options?: any,
  ): Promise<void> {
    // No-op: Cloudflare Workers use processQueuedTask() in the queue consumer.
    // WorkersMessageQueue.listen() throws TypeError by design.
  }
}

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

  cachedQueue = new CloudflareMessageQueue(env.QUEUE_FEDERATION);

  cachedFed = createFederation<FedifyContextData>({
    kv: new WorkersKvStore(env.FEDIFY_KV as unknown as import('@cloudflare/workers-types/experimental').KVNamespace),
    queue: cachedQueue,
    userAgent: {
      software: 'SiliconBeest/1.0',
      url: new URL(`https://${env.INSTANCE_DOMAIN}/`),
    },
    // TODO: Investigate root cause of signature verification failures and remove this.
    // Many remote servers' Accept/Follow and forwarded activities get 401'd because
    // Fedify rejects signer≠actor mismatches and some signature algorithms.
    // With this off, Fedify still checks LD Signatures and Object Integrity Proofs.
    skipSignatureVerification: true,
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
    cachedQueue.waitUntilFn = fn;
  }
}
