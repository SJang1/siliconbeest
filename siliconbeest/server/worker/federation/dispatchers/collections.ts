/**
 * Fedify Collection Dispatchers
 *
 * Re-exports from the collections/ directory. This file was split from
 * an 861-line monolith into focused modules:
 *   - collections/dispatchers.ts - All 6 collection dispatcher registrations
 *   - collections/helpers.ts - Shared helpers (buildFedifyNote, etc.)
 *   - collections/index.ts - Barrel exports
 */

export {
  setupCollectionDispatchers,
  AS_PUBLIC,
  toTemporalInstant,
  buildMediaAttachment,
  buildFedifyNote,
  buildFedifyQuestion,
  resolveAddressing,
  type FedifyNoteResult,
  type FedifyQuestionResult,
} from './collections/index';
