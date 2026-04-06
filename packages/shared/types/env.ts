/**
 * Shared Base Environment Bindings
 *
 * Contains the Cloudflare bindings that are present in BOTH the main
 * worker and the queue consumer. Each package extends this with its
 * own additional bindings.
 *
 * Uses standard Cloudflare Workers types (compatible with wrangler-generated types).
 */

import type { QueueMessage } from './queue';

export interface BaseEnv {
  // D1 Database
  DB: D1Database;

  // R2 Object Storage (media uploads)
  MEDIA_BUCKET: R2Bucket;

  // KV Namespaces
  CACHE: KVNamespace;
  FEDIFY_KV: KVNamespace;

  // Queues (producer bindings)
  QUEUE_FEDERATION: Queue<QueueMessage>;
  QUEUE_INTERNAL: Queue<QueueMessage>;

  // Environment variables
  INSTANCE_DOMAIN: string;

  /**
   * Set to "true" to skip HTTP Signature verification on incoming federation
   * requests. Fedify will still check LD Signatures and Object Integrity
   * Proofs. Useful during development or when debugging signature mismatches.
   */
  SKIP_SIGNATURE_VERIFICATION?: string;
}
