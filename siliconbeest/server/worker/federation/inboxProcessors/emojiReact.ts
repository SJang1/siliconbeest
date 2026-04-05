/**
 * Inbox Processor: EmojiReact
 *
 * Handles incoming EmojiReact activities and Like activities with
 * _misskey_reaction field. Inserts an emoji_reactions record and
 * creates a notification for the status author.
 */

import type { Env } from '../../env';
import type { APActivity } from '../../types/activitypub';
import { generateUlid } from '../../utils/ulid';
import { BaseProcessor } from './BaseProcessor';

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
	async process(activity: APActivity & Record<string, unknown>): Promise<void> {
		const emoji = extractEmoji(activity);
		if (!emoji) {
			console.warn('[emojiReact] No emoji found in activity');
			return;
		}

		const statusUri = this.extractObjectUri(activity);
		if (!statusUri) {
			console.warn('[emojiReact] activity.object is not a string URI');
			return;
		}

		const status = await this.findStatusByUri(statusUri);
		if (!status) {
			console.log(`[emojiReact] Status not found: ${statusUri}`);
			return;
		}

		const actorAccountId = await this.resolveActor(activity.actor);
		if (!actorAccountId) {
			console.error('[emojiReact] Could not resolve remote actor');
			return;
		}

		// Store custom emoji if present in the activity's tag array
		const activityTags = activity.tag as unknown[] | undefined;
		if (Array.isArray(activityTags)) {
			for (const tag of activityTags) {
				const tagObj = tag as Record<string, unknown>;
				if (tagObj.type !== 'Emoji') continue;
				const emojiName = ((tagObj.name as string) || '').replace(/^:|:$/g, '');
				const iconObj = tagObj.icon as Record<string, unknown> | undefined;
				const emojiUrl = iconObj?.url as string | undefined;
				if (!emojiName || !emojiUrl) continue;

				const reactorUri = activity.actor;
				const emojiDomain = new URL(reactorUri).hostname;

				if (emojiDomain) {
					await this.env.DB.prepare(
						`INSERT INTO custom_emojis (id, shortcode, domain, image_key, visible_in_picker, created_at, updated_at)
						 VALUES (?1, ?2, ?3, ?4, 0, datetime('now'), datetime('now'))
						 ON CONFLICT(shortcode, domain) DO UPDATE SET
						   image_key = excluded.image_key,
						   updated_at = datetime('now')`,
					).bind(generateUlid(), emojiName, emojiDomain, emojiUrl).run();
				}
			}
		}

		// Resolve custom_emoji_id for custom emoji reactions
		let customEmojiId: string | null = null;
		if (emoji.startsWith(':') && emoji.endsWith(':')) {
			const shortcode = emoji.slice(1, -1);
			const reactorUri = activity.actor;
			const emojiDomain = new URL(reactorUri).hostname;
			if (emojiDomain) {
				const emojiRow = await this.env.DB.prepare(
					'SELECT id FROM custom_emojis WHERE shortcode = ? AND domain = ? LIMIT 1',
				).bind(shortcode, emojiDomain).first<{ id: string }>();
				if (emojiRow) customEmojiId = emojiRow.id;
			}
		}

		// Insert emoji reaction (ignore duplicate)
		const reactionId = generateUlid();
		const now = new Date().toISOString();

		try {
			await this.env.DB.prepare(
				`INSERT INTO emoji_reactions (id, account_id, status_id, emoji, custom_emoji_id, created_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
			)
				.bind(reactionId, actorAccountId, status.id, emoji, customEmojiId, now)
				.run();
		} catch {
			return; // Duplicate reaction
		}

		await this.notifyIfLocal('emoji_reaction', status.account_id, actorAccountId, status.id);
	}
}

export async function processEmojiReact(
	activity: APActivity & Record<string, unknown>,
	_localAccountId: string,
	env: Env,
): Promise<void> {
	await new EmojiReactProcessor(env).process(activity);
}
