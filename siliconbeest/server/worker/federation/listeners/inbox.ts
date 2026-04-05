/**
 * Fedify Inbox Listener Registration
 *
 * Delegates to the shared inbox listener factory, passing Fedify vocab
 * types from this worker's own node_modules to avoid the dual-package hazard.
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

import type { FedifyContextData } from '../fedify';
import { setupInboxListeners } from '../../../../../packages/shared/activitypub/inbox-listeners';

import { processFollow } from '../inboxProcessors/follow';
import { processCreate } from '../inboxProcessors/create';
import { processAccept } from '../inboxProcessors/accept';
import { processReject } from '../inboxProcessors/reject';
import { processLike } from '../inboxProcessors/like';
import { processAnnounce } from '../inboxProcessors/announce';
import { processDelete } from '../inboxProcessors/delete';
import { processUpdate } from '../inboxProcessors/update';
import { processUndo } from '../inboxProcessors/undo';
import { processBlock } from '../inboxProcessors/block';
import { processMove } from '../inboxProcessors/move';
import { processFlag } from '../inboxProcessors/flag';
import { processEmojiReact } from '../inboxProcessors/emojiReact';

export function setupWorkerInboxListeners(
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
	);
}
