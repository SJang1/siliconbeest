/**
 * Fedify Federation Instance Factory
 *
 * Creates a Fedify Federation instance configured for Cloudflare Workers.
 * The instance must be created INSIDE fetch()/queue() handlers, not globally,
 * because Cloudflare Workers bindings (KV, Queues) are only available as
 * method arguments.
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
 * Wrapper around WorkersMessageQueue that makes listen() a no-op.
 *
 * WorkersMessageQueue.listen() throws by design because Cloudflare Workers
 * don't support background listeners — the queue consumer uses
 * federation.processQueuedTask() instead. However, Fedify's sendActivity()
 * internally calls queue.listen() as a side-effect. This wrapper prevents
 * that TypeError from becoming an unhandled rejection.
 *
 * enqueue() works normally — messages are sent to the Cloudflare Queue
 * and processed by the queue consumer worker.
 */
class CloudflareMessageQueue implements MessageQueue {
  private inner: WorkersMessageQueue;

  constructor(queue: Queue) {
    this.inner = new WorkersMessageQueue(queue);
  }

  enqueue(
    message: any,
    options?: any,
  ): Promise<void> {
    return this.inner.enqueue(message, options);
  }

  async listen(
    _handler: (message: any) => Promise<void> | void,
    _options?: any,
  ): Promise<void> {
    // No-op: Cloudflare Workers use processQueuedTask() in the queue consumer.
    // WorkersMessageQueue.listen() throws TypeError by design.
  }
}

/**
 * Create a Fedify Federation instance for this request.
 *
 * When a queue is provided (QUEUE_FEDERATION), Fedify uses it for
 * asynchronous activity delivery via `sendActivity()`. The queue
 * consumer calls `federation.processQueuedTask()` to process them.
 *
 * @param env Cloudflare Workers Env bindings
 * @returns Configured Federation instance
 */
export function createFed(env: Env): Federation<FedifyContextData> {
  return createFederation<FedifyContextData>({
    kv: new WorkersKvStore(env.FEDIFY_KV as any),
    queue: new CloudflareMessageQueue(env.QUEUE_FEDERATION),
  });
}
