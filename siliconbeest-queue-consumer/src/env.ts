/**
 * Environment bindings for the queue consumer worker.
 *
 * Matches the bindings declared in wrangler.jsonc.
 */
export interface Env {
  DB: D1Database;
  MEDIA_BUCKET: R2Bucket;
  CACHE: KVNamespace;
  FEDIFY_KV: KVNamespace;
  QUEUE_FEDERATION: Queue;
  QUEUE_INTERNAL: Queue;
  WORKER: Fetcher; // service binding to main worker
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  INSTANCE_DOMAIN: string;
}
