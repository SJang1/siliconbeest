import type { BaseEnv } from '../types/env';

/**
 * Context data passed to all Fedify dispatchers and listeners.
 * Generic over the environment type so both the worker and queue consumer
 * can bind their specific Env while sharing a single definition.
 *
 * The default parameter `= BaseEnv` means code that references
 * `FedifyContextData` without a type argument keeps compiling.
 */
export interface FedifyContextData<TEnv extends BaseEnv = BaseEnv> {
  /** Cloudflare Workers environment bindings (D1, R2, KV, Queues, etc.) */
  env: TEnv;
}
