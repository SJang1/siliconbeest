import { Hono } from 'hono';

import type { QueueMessage } from './types/queue';

/**
 * Cloudflare Workers environment bindings.
 * Must match the bindings declared in wrangler.jsonc.
 */
export interface Env {
  // D1 Database
  DB: D1Database;

  // R2 Object Storage (media uploads)
  MEDIA_BUCKET: R2Bucket;

  // KV Namespaces
  CACHE: KVNamespace;
  SESSIONS: KVNamespace;

  // Queues (producer bindings)
  QUEUE_FEDERATION: Queue<QueueMessage>;
  QUEUE_INTERNAL: Queue<QueueMessage>;

  // Durable Objects
  STREAMING_DO: DurableObjectNamespace;

  // Environment variables (wrangler.jsonc vars)
  INSTANCE_DOMAIN: string;
  INSTANCE_TITLE: string;
  REGISTRATION_MODE: string;

  // Secrets (wrangler secret put)
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  OTP_ENCRYPTION_KEY: string;

  // SMTP (optional — email sending)
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_FROM?: string;
}

/**
 * Hono context variables set by middleware.
 */
export interface AppVariables {
  currentUser: {
    id: string;
    account_id: string;
    email: string;
    role: string;
  } | null;
  currentAccount: {
    id: string;
    username: string;
    domain: string | null;
  } | null;
  requestId: string;
  /** True when the client accepts ActivityPub content types. */
  isActivityPub: boolean;
}

/**
 * Fully-typed Hono app used across the project.
 */
export type AppType = Hono<{ Bindings: Env; Variables: AppVariables }>;
