/**
 * Inbox Processor: EmojiReact
 *
 * Handles incoming EmojiReact activities and Like activities with
 * _misskey_reaction field. Inserts an emoji_reactions record and
 * creates a notification for the status author.
 */

import { env } from 'cloudflare:workers';
import type { APActivity } from '../../types/activitypub';
import { generateUlid } from '../../utils/ulid';
import { broadcastReactionEvent } from '../../services/streaming';
import { BaseProcessor } from './BaseProcessor';
import { customEmojiTagDomain, emojiTagToCustomEmoji } from '../../../../../packages/shared/utils/customEmoji';
import { canProcessFederatedStatusInteraction } from '../../services/permissions';

/**
 * Extract emoji from an activity.
 * Checks _misskey_reaction first, then content field.
 */
function extractEmoji(activity: APActivity & Record<string, unknown>): string | null {
	if (typeof activity._misskey_reaction === 'string' && activity._misskey_reaction) {
		return activity._misskey_reaction;
	}
	if (typeof activity.content === 'string' && activity.content) {
		return activity.content;
	}
	return null;
}

class EmojiReactProcessor extends BaseProcessor {
	async process(activity: APActivity & Record<string, unknown>): Promise<boolean> {
		const emoji = extractEmoji(activity);
		if (!emoji) {
			console.warn('[emojiReact] No emoji found in activity');
			return false;
		}

		const statusUri = this.extractObjectUri(activity);
		if (!statusUri) {
			console.warn('[emojiReact] activity.object is not a string URI');
			return false;
		}

		const status = await this.findStatusByUri(statusUri);
		if (!status) {
			console.log(`[emojiReact] Status not found: ${statusUri}`);
			return false;
		}

		const actorAccountId = await this.resolveActor(activity.actor);
		if (!actorAccountId) {
			console.error('[emojiReact] Could not resolve remote actor');
			return false;
		}
		if (!await canProcessFederatedStatusInteraction(
			status.id,
			actorAccountId,
			this.recipientAccountId || null,
		)) return false;

		// Store custom emoji if present in the activity's tag array
		const activityTags = activity.tag as (Record<string, unknown>)[] | undefined;
		let customEmojiDomain: string | null = null;
		if (Array.isArray(activityTags)) {
			for (const tagObj of activityTags) {
				if (tagObj.type !== 'Emoji') continue;
				const customEmoji = emojiTagToCustomEmoji(tagObj);
				if (!customEmoji) continue;
				const emojiDomain = customEmojiTagDomain(tagObj, activity.actor);

				if (emojiDomain) {
					if (emoji === `:${customEmoji.shortcode}:`) customEmojiDomain = emojiDomain;
					await env.DB_META_C000.prepare(
						`INSERT INTO custom_emojis (id, shortcode, domain, image_key, visible_in_picker, created_at, updated_at)
						 VALUES (?1, ?2, ?3, ?4, 0, datetime('now'), datetime('now'))
						 ON CONFLICT(shortcode, domain) DO UPDATE SET
						   image_key = excluded.image_key,
						   updated_at = datetime('now')`,
					).bind(generateUlid(), customEmoji.shortcode, emojiDomain, customEmoji.url).run();
				}
			}
		}

		// Resolve custom_emoji_id for custom emoji reactions
		let customEmojiId: string | null = null;
		if (emoji.startsWith(':') && emoji.endsWith(':')) {
			const shortcode = emoji.slice(1, -1);
			const emojiDomain = customEmojiDomain ?? new URL(activity.actor).hostname;
			if (emojiDomain) {
				const emojiRow = await env.DB_META_C000.prepare(
					'SELECT id FROM custom_emojis WHERE shortcode = ? AND domain = ? LIMIT 1',
				).bind(shortcode, emojiDomain).first<{ id: string }>();
				if (emojiRow) customEmojiId = emojiRow.id;
			}
		}

		// Insert emoji reaction (ignore duplicate)
		const reactionId = generateUlid();
		const now = new Date().toISOString();

		try {
			await env.DB_META_C000.prepare(
				`INSERT INTO emoji_reactions (id, account_id, status_id, emoji, custom_emoji_id, created_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
			)
				.bind(reactionId, actorAccountId, status.id, emoji, customEmojiId, now)
				.run();
		} catch {
			return false; // Duplicate reaction
		}

		await this.notifyIfLocal('emoji_reaction', status.account_id, actorAccountId, status.id);

		// Live-update connected clients viewing this status
		await broadcastReactionEvent(status.id);
		return true;
	}
}

export async function processEmojiReact(
	activity: APActivity & Record<string, unknown>,
	localAccountId: string,
): Promise<boolean> {
	return new EmojiReactProcessor(localAccountId).process(activity);
}
