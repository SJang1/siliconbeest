import { Hono } from 'hono';

import type { Federation } from '@fedify/fedify';
import type { SendEmailMessage } from './types/queue';
import type { FedifyContextData } from './federation/fedify';
import type { BaseEnv } from '../../../packages/shared/types/env';

/**
 * Cloudflare Workers environment bindings.
 * Must match the bindings declared in wrangler.jsonc.
 */
export type Env = BaseEnv & {
  // KV Namespaces (worker-only)
  readonly SESSIONS: KVNamespace;

  // Queues (worker-only)
  readonly QUEUE_EMAIL: Queue<SendEmailMessage>;

  // Durable Objects (worker-only)
  readonly STREAMING_DO: DurableObjectNamespace;

  // Environment variables (wrangler.jsonc vars)
  readonly INSTANCE_TITLE: string;
  readonly REGISTRATION_MODE: string;

  // Secrets (worker-only)
  readonly OTP_ENCRYPTION_KEY: string;
};

/**
 * Hono context variables set by middleware.
 */
export type AppVariables = {
  currentUser: {
    readonly id: string;
    readonly account_id: string;
    readonly email: string;
    readonly role: string;
  } | null;
  currentAccount: {
    readonly id: string;
    readonly username: string;
    readonly domain: string | null;
  } | null;
  /** OAuth token scopes (space-separated), e.g. "read write follow push". */
  tokenScopes: string | null;
  /** The oauth_access_tokens row ID for the current bearer token. */
  tokenId: string | null;
  requestId: string;
  /** True when the client accepts ActivityPub content types. */
  isActivityPub: boolean;
  /** Fedify Federation instance (created per-request in middleware). */
  federation: Federation<FedifyContextData>;
};

/**
 * Fully-typed Hono app used across the project.
 */
export type AppType = Hono<{ Bindings: Env; Variables: AppVariables }>;
