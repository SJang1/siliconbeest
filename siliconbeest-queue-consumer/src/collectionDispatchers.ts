/**
 * Fedify Collection Dispatchers (Queue Consumer)
 *
 * Minimal version of the worker's collection dispatchers.
 * Only registers the followers dispatcher, which is needed for
 * fanout resolution during processQueuedTask().
 *
 * The followers dispatcher logic is shared with the main worker via
 * packages/shared/federation/collection-dispatchers.ts, which uses
 * structural types to avoid the Fedify dual-package hazard.
 */

import type { Federation } from '@fedify/fedify';
import type { FedifyContextData } from './fedify';
import { setupFollowersDispatcher } from '../../packages/shared/federation/collection-dispatchers';

/**
 * Register collection dispatchers needed by the queue consumer.
 * Currently only the followers dispatcher is required (for fanout).
 */
export function setupCollectionDispatchers(
  federation: Federation<FedifyContextData>,
): void {
  setupFollowersDispatcher(federation);
}
