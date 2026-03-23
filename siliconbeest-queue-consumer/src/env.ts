/**
 * Environment bindings for the queue consumer worker.
 *
 * Matches the bindings declared in wrangler.jsonc.
 */
export interface Env {
  DB: D1Database;
  MEDIA_BUCKET: R2Bucket;
  CACHE: KVNamespace;
  QUEUE_FEDERATION: Queue;
  QUEUE_INTERNAL: Queue;
  WORKER: Fetcher; // service binding to main worker
  VAPID_PUBLIC_KEY: string; // base64url-encoded ECDSA P-256 public key (65 bytes)
  VAPID_PRIVATE_KEY: string; // base64url-encoded ECDSA P-256 private key (32 bytes)
}
