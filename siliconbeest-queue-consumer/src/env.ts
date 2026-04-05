/**
 * Environment bindings for the queue consumer worker.
 *
 * Matches the bindings declared in wrangler.jsonc.
 */
import type { BaseEnv } from '../../packages/shared/types/env';

export interface Env extends BaseEnv {
  WORKER: Fetcher; // service binding to main worker
}
