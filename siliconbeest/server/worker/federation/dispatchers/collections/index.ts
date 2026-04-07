/**
 * Fedify Collection Dispatchers
 *
 * Registers followers, following, outbox, featured, featured-tags, and liked
 * collection dispatchers on the Fedify Federation instance.
 *
 * Each dispatcher queries D1 and returns Fedify vocabulary objects. Fedify
 * handles the OrderedCollection / OrderedCollectionPage wrapper, @context,
 * and content-negotiation automatically.
 */

export { setupCollectionDispatchers } from './dispatchers';
export {
  AS_PUBLIC,
  toTemporalInstant,
  buildMediaAttachment,
  buildFedifyNote,
  buildFedifyQuestion,
  resolveAddressing,
  type FedifyNoteResult,
  type FedifyQuestionResult,
} from './helpers';
