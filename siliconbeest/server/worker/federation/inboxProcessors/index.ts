/**
 * Inbox Activity Dispatcher
 *
 * Routes inbound ActivityPub activities to the appropriate processor
 * based on the activity type. Used by both the personal inbox and
 * the shared inbox endpoints.
 */

import type { Env } from '../../env';
import type { APActivity } from '../../types/activitypub';

import { processCreate } from './create';
import { processFollow } from './follow';
import { processAccept } from './accept';
import { processReject } from './reject';
import { processLike } from './like';
import { processAnnounce } from './announce';
import { processDelete } from './delete';
import { processUpdate } from './update';
import { processUndo } from './undo';
import { processBlock } from './block';
import { processMove } from './move';
import { processFlag } from './flag';
import { processEmojiReact } from './emojiReact';

/**
 * Process an inbound ActivityPub activity by dispatching to the
 * appropriate handler based on the activity type.
 *
 * @param activity - The parsed ActivityPub activity
 * @param localAccountId - The account ID of the local recipient (empty string for shared inbox)
 * @param env - Cloudflare Workers environment bindings
 */
export async function processInboxActivity(
	activity: APActivity,
	localAccountId: string,
	env: Env,
): Promise<void> {
	switch (activity.type) {
		case 'Create':
			return processCreate(activity, localAccountId, env);
		case 'Follow':
			return processFollow(activity, localAccountId, env);
		case 'Accept':
			return processAccept(activity, localAccountId, env);
		case 'Reject':
			return processReject(activity, localAccountId, env);
		case 'Like': {
			const anyActivity = activity as APActivity & Record<string, unknown>;
			if (anyActivity._misskey_reaction || anyActivity.content) {
				return processEmojiReact(anyActivity, localAccountId, env);
			}
			return processLike(activity, localAccountId, env);
		}
		case 'Announce':
			return processAnnounce(activity, localAccountId, env);
		case 'Delete':
			return processDelete(activity, localAccountId, env);
		case 'Update':
			return processUpdate(activity, localAccountId, env);
		case 'Undo':
			return processUndo(activity, localAccountId, env);
		case 'Block':
			return processBlock(activity, localAccountId, env);
		case 'Move':
			return processMove(activity, localAccountId, env);
		case 'Flag':
			return processFlag(activity, localAccountId, env);
		case 'EmojiReact':
			return processEmojiReact(
				activity as APActivity & Record<string, unknown>,
				localAccountId,
				env,
			);
		default:
			console.warn(`[inbox] Unhandled activity type: ${activity.type}`);
	}
}
