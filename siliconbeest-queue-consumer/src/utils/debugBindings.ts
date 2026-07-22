/**
 * Instrument the consumer's Cloudflare bindings (D1, KV, R2, Queues) with
 * verbose debug logging. Once instrumented, every binding operation — SQL
 * statements and their results, KV/R2 reads and writes, queue sends — is
 * logged through `debugLog` with ultra-sensitive redaction applied.
 *
 * Bindings are isolate-wide singletons, so instrumenting them once covers
 * every call site in the isolate. No-op unless `DEBUG` is enabled.
 */

import { env } from 'cloudflare:workers';
import { isDebugEnabled } from '../../../packages/shared/utils/debugLog';
import {
  instrumentD1ForDebug,
  instrumentFetchForDebug,
  instrumentKVForDebug,
  instrumentQueueForDebug,
  instrumentR2ForDebug,
} from '../../../packages/shared/utils/debugBindings';

let instrumented = false;

/** Instrument all bindings once per isolate. Cheap no-op otherwise. */
export function ensureDebugBindingLogging(): void {
  if (instrumented || !isDebugEnabled()) return;
  instrumented = true;
  // Read via an index signature so environments missing optional bindings
  // still work.
  const bindings = env as unknown as Record<string, unknown>;
  instrumentD1ForDebug(bindings.DB_META_C000, 'DB_META_C000');
  instrumentKVForDebug(bindings.CACHE, 'CACHE');
  instrumentKVForDebug(bindings.FEDIFY_KV, 'FEDIFY_KV');
  instrumentR2ForDebug(bindings.MEDIA_BUCKET, 'MEDIA_BUCKET');
  instrumentQueueForDebug(bindings.QUEUE_FEDERATION, 'QUEUE_FEDERATION');
  instrumentQueueForDebug(bindings.QUEUE_INTERNAL, 'QUEUE_INTERNAL');
  // Raw outbound HTTP: remote account/status fetches and activity
  // deliveries to remote inboxes.
  instrumentFetchForDebug();
}
