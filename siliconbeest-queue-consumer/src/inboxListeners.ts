/**
 * Fedify Inbox Listener Registration (Queue Consumer)
 *
 * Delegates to the shared inbox listener factory, passing Fedify vocab
 * types from the consumer's own node_modules to avoid the dual-package hazard.
 *
 * The processor functions (plain business logic) are imported from the
 * worker's source tree — they have no Fedify vocab dependency.
 */

import type { Federation } from '@fedify/fedify';
import {
	Follow,
	Create,
	Like,
	Announce,
	Delete,
	Update,
	Undo,
	Block,
	Flag,
	Move,
	Accept,
	Reject,
	EmojiReact,
} from '@fedify/vocab';

import type { FedifyContextData } from './fedify';
import { measureAsync } from './observability/performance';
import { setupInboxListeners } from '../../packages/shared/activitypub/inbox-listeners';

import {
	processFollow,
	processCreate,
	processAccept,
	processReject,
	processLike,
	processAnnounce,
	processDelete,
	processUpdate,
	processUndo,
	processBlock,
	processMove,
	processFlag,
	processEmojiReact,
} from '../../siliconbeest/server/worker/federation/inboxProcessors/processors';

export function setupConsumerInboxListeners(
	federation: Federation<FedifyContextData>,
): void {
	setupInboxListeners(
		federation,
		{
			Follow,
			Create,
			Like,
			Announce,
			Delete,
			Update,
			Undo,
			Block,
			Flag,
			Move,
			Accept,
			Reject,
			EmojiReact,
		},
		{
			processFollow,
			processCreate,
			processAccept,
			processReject,
			processLike,
			processAnnounce,
			processDelete,
			processUpdate,
			processUndo,
			processBlock,
			processMove,
			processFlag,
			processEmojiReact,
		},
		{ measure: measureAsync },
	);
}
