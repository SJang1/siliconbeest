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

import { processFollow } from '../../siliconbeest/server/worker/federation/inboxProcessors/follow';
import { processCreate } from '../../siliconbeest/server/worker/federation/inboxProcessors/create';
import { processAccept } from '../../siliconbeest/server/worker/federation/inboxProcessors/accept';
import { processReject } from '../../siliconbeest/server/worker/federation/inboxProcessors/reject';
import { processLike } from '../../siliconbeest/server/worker/federation/inboxProcessors/like';
import { processAnnounce } from '../../siliconbeest/server/worker/federation/inboxProcessors/announce';
import { processDelete } from '../../siliconbeest/server/worker/federation/inboxProcessors/delete';
import { processUpdate } from '../../siliconbeest/server/worker/federation/inboxProcessors/update';
import { processUndo } from '../../siliconbeest/server/worker/federation/inboxProcessors/undo';
import { processBlock } from '../../siliconbeest/server/worker/federation/inboxProcessors/block';
import { processMove } from '../../siliconbeest/server/worker/federation/inboxProcessors/move';
import { processFlag } from '../../siliconbeest/server/worker/federation/inboxProcessors/flag';
import { processEmojiReact } from '../../siliconbeest/server/worker/federation/inboxProcessors/emojiReact';

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
