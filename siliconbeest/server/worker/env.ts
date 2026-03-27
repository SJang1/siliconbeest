import { Hono } from 'hono';

import type { Federation } from '@fedify/fedify';
import type { QueueMessage, SendEmailMessage } from './types/queue';
import type { FedifyContextData } from './federation/fedify';

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
  FEDIFY_KV: KVNamespace;

  // Queues (producer bindings)
  QUEUE_FEDERATION: Queue<QueueMessage>;
  QUEUE_INTERNAL: Queue<QueueMessage>;
  QUEUE_EMAIL: Queue<SendEmailMessage>;

  // Durable Objects
  STREAMING_DO: DurableObjectNamespace;

  // Environment variables (wrangler.jsonc vars)
  INSTANCE_DOMAIN: string;
  INSTANCE_TITLE: string;
  REGISTRATION_MODE: string;

  // Secrets (wrangler secret put) — optional; DB settings take priority
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  OTP_ENCRYPTION_KEY: string;

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
  /** Fedify Federation instance (created per-request in middleware). */
  federation: Federation<FedifyContextData>;
}

/**
 * Fully-typed Hono app used across the project.
 */
export type AppType = Hono<{ Bindings: Env; Variables: AppVariables }>;
