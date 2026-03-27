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
import { resolveRemoteAccount } from '../resolveRemoteAccount';

/**
 * Extract emoji from an activity.
 * Checks _misskey_reaction first, then content field, then tag field.
 */
function extractEmoji(activity: APActivity & Record<string, unknown>): string | null {
	// Misskey-style _misskey_reaction field
	if (typeof activity._misskey_reaction === 'string' && activity._misskey_reaction) {
		return activity._misskey_reaction;
	}

	// Content field (used by some implementations)
	if (typeof activity.content === 'string' && activity.content) {
		return activity.content;
	}

	return null;
}

export async function processEmojiReact(
	activity: APActivity & Record<string, unknown>,
	_localAccountId: string,
	env: Env,
): Promise<void> {
	const emoji = extractEmoji(activity);
	if (!emoji) {
		console.warn('[emojiReact] No emoji found in activity');
		return;
	}

	const statusUri =
		typeof activity.object === 'string' ? activity.object : undefined;

	if (!statusUri) {
		console.warn('[emojiReact] activity.object is not a string URI');
		return;
	}

	// Find the target status
	const status = await env.DB.prepare(
		`SELECT id, account_id FROM statuses WHERE uri = ?1 LIMIT 1`,
	)
		.bind(statusUri)
		.first<{ id: string; account_id: string }>();

	if (!status) {
		console.log(`[emojiReact] Status not found: ${statusUri}`);
		return;
	}

	// Resolve the remote actor
	const actorAccountId = await resolveRemoteAccount(activity.actor, env);
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

			// Use actor's server domain, not CDN hostname from emoji URL
			const reactorUri = typeof activity.actor === 'string' ? activity.actor : (activity.actor as any)?.id || '';
			let emojiDomain: string | null = null;
			try { emojiDomain = new URL(reactorUri).hostname; } catch { /* skip */ }

			if (emojiDomain) {
				await env.DB.prepare(
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
		// Look up the custom emoji we just stored (or already existed)
		const reactorUri = typeof activity.actor === 'string' ? activity.actor : (activity.actor as any)?.id || '';
		let emojiDomain: string | null = null;
		try { emojiDomain = new URL(reactorUri).hostname; } catch { /* skip */ }
		if (emojiDomain) {
			const emojiRow = await env.DB.prepare(
				'SELECT id FROM custom_emojis WHERE shortcode = ? AND domain = ? LIMIT 1',
			).bind(shortcode, emojiDomain).first<{ id: string }>();
			if (emojiRow) customEmojiId = emojiRow.id;
		}
	}

	// Insert emoji reaction (ignore duplicate via UNIQUE constraint)
	const reactionId = generateUlid();
	const now = new Date().toISOString();

	try {
		await env.DB.prepare(
			`INSERT INTO emoji_reactions (id, account_id, status_id, emoji, custom_emoji_id, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
		)
			.bind(reactionId, actorAccountId, status.id, emoji, customEmojiId, now)
			.run();
	} catch {
		// Duplicate reaction, ignore
		return;
	}

	// Create notification for the status author (only if local)
	const isLocalAuthor = await env.DB.prepare(
		`SELECT id FROM accounts WHERE id = ?1 AND domain IS NULL LIMIT 1`,
	)
		.bind(status.account_id)
		.first();

	if (isLocalAuthor) {
		await env.QUEUE_INTERNAL.send({
			type: 'create_notification',
			recipientAccountId: status.account_id,
			senderAccountId: actorAccountId,
			notificationType: 'emoji_reaction',
			statusId: status.id,
			emoji,
		});
	}
}
