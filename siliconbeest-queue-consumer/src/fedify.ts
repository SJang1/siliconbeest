/**
 * Fedify Federation Instance Factory (Queue Consumer)
 *
 * Creates a Fedify Federation instance configured for Cloudflare Workers.
 * The instance must be created INSIDE queue() handlers, not globally,
 * because Cloudflare Workers bindings (KV, Queues) are only available as
 * method arguments.
 *
 * @see https://fedify.dev/
 * @see https://github.com/fedify-dev/fedify
 */

import { createFederation, type Federation } from '@fedify/fedify';
import { WorkersKvStore, WorkersMessageQueue } from '@fedify/cfworkers';
import type { Env } from './env';

/**
 * Context data passed to all Fedify dispatchers and listeners.
 * Provides access to Cloudflare Workers environment bindings.
 */
export interface FedifyContextData {
  /** Cloudflare Workers environment bindings (D1, R2, KV, Queues, etc.) */
  env: Env;
}

/**
 * Create a Fedify Federation instance for queue processing.
 *
 * The queue binding is required so that `processQueuedTask()` can
 * re-enqueue retries through the same WorkersMessageQueue that the
 * main worker uses for `sendActivity()`.
 *
 * @param env Cloudflare Workers Env bindings
 * @returns Configured Federation instance
 */
export function createFed(env: Env): Federation<FedifyContextData> {
  return createFederation<FedifyContextData>({
    kv: new WorkersKvStore(env.FEDIFY_KV as unknown as import('@cloudflare/workers-types/experimental').KVNamespace),
    queue: new WorkersMessageQueue(env.QUEUE_FEDERATION),
  });
}
