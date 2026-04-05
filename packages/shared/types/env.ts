/**
 * Shared Base Environment Bindings
 *
 * Contains the Cloudflare bindings that are present in BOTH the main
 * worker and the queue consumer. Each package extends this with its
 * own additional bindings.
 *
 * Worker (siliconbeest/server/worker/env.ts) adds:
 *   SESSIONS, QUEUE_EMAIL, STREAMING_DO, INSTANCE_TITLE,
 *   REGISTRATION_MODE, OTP_ENCRYPTION_KEY
 *
 * Consumer (siliconbeest-queue-consumer/src/env.ts) adds:
 *   WORKER (service binding)
 */

export interface BaseEnv {
  // D1 Database
  DB: D1Database;

  // R2 Object Storage (media uploads)
  MEDIA_BUCKET: R2Bucket;

  // KV Namespaces
  CACHE: KVNamespace;
  FEDIFY_KV: KVNamespace;

  // Queues (unparameterized — each package adds its own generic)
  QUEUE_FEDERATION: Queue;
  QUEUE_INTERNAL: Queue;

  // Environment variables
  INSTANCE_DOMAIN: string;

  // Secrets (optional — may be stored in DB settings instead)
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
}
