/**
 * Inbox Processor: Undo
 *
 * Handles incoming Undo activities. Reverses a previous Follow, Like,
 * Announce, or Block by the same actor.
 */

import type { Env } from '../../env';
import type { APActivity, APObject } from '../../types/activitypub';

/**
 * Determine the type and target of the activity being undone.
 */
function parseUndoTarget(object: APActivity['object']): {
	type: string | null;
	objectUri: string | null;
	activityUri: string | null;
} {
	if (!object) return { type: null, objectUri: null, activityUri: null };

	if (typeof object === 'string') {
		// Bare URI — we'll try to look it up
		return { type: null, objectUri: null, activityUri: object };
	}

	const obj = object as APObject & { actor?: string; object?: string | APObject };
	const innerObject = obj.object;

	return {
		type: obj.type ?? null,
		objectUri: typeof innerObject === 'string'
			? innerObject
			: (innerObject as APObject)?.id ?? null,
		activityUri: obj.id ?? null,
	};
}

export async function processUndo(
	activity: APActivity,
	_localAccountId: string,
	env: Env,
): Promise<void> {
	const { type, objectUri, activityUri } = parseUndoTarget(activity.object);

	// Resolve the actor
	const actorAccount = await env.DB.prepare(
		`SELECT id FROM accounts WHERE uri = ?1 LIMIT 1`,
	)
		.bind(activity.actor)
		.first<{ id: string }>();

	if (!actorAccount) {
		console.warn(`[undo] Actor not found: ${activity.actor}`);
		return;
	}

	switch (type) {
		case 'Follow':
			await undoFollow(actorAccount.id, objectUri, activityUri, env);
			break;
		case 'Like': {
			// Check if the inner Like activity has _misskey_reaction (emoji reaction undo)
			const innerObj = activity.object as unknown as Record<string, unknown> | undefined;
			if (innerObj && (innerObj._misskey_reaction || innerObj.content)) {
				await undoEmojiReaction(
					actorAccount.id,
					objectUri,
					(innerObj._misskey_reaction ?? innerObj.content) as string,
					env,
				);
			} else {
				await undoLike(actorAccount.id, objectUri, activityUri, env);
			}
			break;
		}
		case 'Announce':
			await undoAnnounce(actorAccount.id, objectUri, env);
			break;
		case 'Block':
			await undoBlock(actorAccount.id, objectUri, env);
			break;
		default:
			// If type is unknown but we have an activityUri, try to match by URI
			if (activityUri) {
				// Try follow
				const followResult = await env.DB.prepare(
					`DELETE FROM follows WHERE uri = ?1 AND account_id = ?2`,
				)
					.bind(activityUri, actorAccount.id)
					.run();
				if ((followResult.meta?.changes ?? 0) > 0) {
					console.log('[undo] Undid follow by URI');
					return;
				}
				// Try follow_request
				await env.DB.prepare(
					`DELETE FROM follow_requests WHERE uri = ?1 AND account_id = ?2`,
				)
					.bind(activityUri, actorAccount.id)
					.run();
			}
			console.log(`[undo] Unhandled undo type: ${type}`);
			break;
	}
}

async function undoFollow(
	actorAccountId: string,
	targetUri: string | null,
	followUri: string | null,
	env: Env,
): Promise<void> {
	let targetAccountId: string | null = null;

	if (targetUri) {
		const target = await env.DB.prepare(
			`SELECT id FROM accounts WHERE uri = ?1 LIMIT 1`,
		)
			.bind(targetUri)
			.first<{ id: string }>();
		targetAccountId = target?.id ?? null;
	}

	// Try to delete from follows
	let deleted = false;

	if (followUri) {
		const result = await env.DB.prepare(
			`DELETE FROM follows WHERE uri = ?1 AND account_id = ?2`,
		)
			.bind(followUri, actorAccountId)
			.run();
		deleted = (result.meta?.changes ?? 0) > 0;
	}

	if (!deleted && targetAccountId) {
		const result = await env.DB.prepare(
			`DELETE FROM follows WHERE account_id = ?1 AND target_account_id = ?2`,
		)
			.bind(actorAccountId, targetAccountId)
			.run();
		deleted = (result.meta?.changes ?? 0) > 0;
	}

	if (deleted && targetAccountId) {
		// Update counts
		await env.DB.batch([
			env.DB.prepare(
				`UPDATE accounts SET followers_count = MAX(0, followers_count - 1) WHERE id = ?1`,
			).bind(targetAccountId),
			env.DB.prepare(
				`UPDATE accounts SET following_count = MAX(0, following_count - 1) WHERE id = ?1`,
			).bind(actorAccountId),
		]);
	}

	// Also try to remove any pending follow_request
	if (targetAccountId) {
		await env.DB.prepare(
			`DELETE FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2`,
		)
			.bind(actorAccountId, targetAccountId)
			.run();
	}
}

async function undoLike(
	actorAccountId: string,
	statusUri: string | null,
	likeUri: string | null,
	env: Env,
): Promise<void> {
	let statusId: string | null = null;

	// Try deleting by like URI first
	if (likeUri) {
		const fav = await env.DB.prepare(
			`SELECT id, status_id FROM favourites WHERE uri = ?1 AND account_id = ?2 LIMIT 1`,
		)
			.bind(likeUri, actorAccountId)
			.first<{ id: string; status_id: string }>();

		if (fav) {
			statusId = fav.status_id;
			await env.DB.prepare(`DELETE FROM favourites WHERE id = ?1`).bind(fav.id).run();
		}
	}

	// Fallback: delete by status URI
	if (!statusId && statusUri) {
		const status = await env.DB.prepare(
			`SELECT id FROM statuses WHERE uri = ?1 LIMIT 1`,
		)
			.bind(statusUri)
			.first<{ id: string }>();

		if (status) {
			statusId = status.id;
			await env.DB.prepare(
				`DELETE FROM favourites WHERE account_id = ?1 AND status_id = ?2`,
			)
				.bind(actorAccountId, statusId)
				.run();
		}
	}

	// Decrement favourites_count
	if (statusId) {
		await env.DB.prepare(
			`UPDATE statuses SET favourites_count = MAX(0, favourites_count - 1) WHERE id = ?1`,
		)
			.bind(statusId)
			.run();
	}
}

async function undoAnnounce(
	actorAccountId: string,
	originalStatusUri: string | null,
	env: Env,
): Promise<void> {
	if (!originalStatusUri) {
		console.warn('[undo] Cannot undo announce without original status URI');
		return;
	}

	// Find the original status
	const originalStatus = await env.DB.prepare(
		`SELECT id FROM statuses WHERE uri = ?1 LIMIT 1`,
	)
		.bind(originalStatusUri)
		.first<{ id: string }>();

	if (!originalStatus) return;

	const now = new Date().toISOString();

	// Soft-delete the reblog
	const reblog = await env.DB.prepare(
		`SELECT id FROM statuses
		 WHERE reblog_of_id = ?1 AND account_id = ?2 AND deleted_at IS NULL
		 LIMIT 1`,
	)
		.bind(originalStatus.id, actorAccountId)
		.first<{ id: string }>();

	if (reblog) {
		await env.DB.prepare(
			`UPDATE statuses SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3`,
		)
			.bind(now, now, reblog.id)
			.run();

		// Remove from timelines
		await env.DB.prepare(
			`DELETE FROM home_timeline_entries WHERE status_id = ?1`,
		)
			.bind(reblog.id)
			.run();
	}

	// Decrement reblogs_count
	await env.DB.prepare(
		`UPDATE statuses SET reblogs_count = MAX(0, reblogs_count - 1) WHERE id = ?1`,
	)
		.bind(originalStatus.id)
		.run();
}

async function undoEmojiReaction(
	actorAccountId: string,
	statusUri: string | null,
	emoji: string,
	env: Env,
): Promise<void> {
	if (!statusUri) {
		console.warn('[undo] Cannot undo emoji reaction without status URI');
		return;
	}

	const status = await env.DB.prepare(
		`SELECT id FROM statuses WHERE uri = ?1 LIMIT 1`,
	)
		.bind(statusUri)
		.first<{ id: string }>();

	if (!status) return;

	await env.DB.prepare(
		`DELETE FROM emoji_reactions WHERE account_id = ?1 AND status_id = ?2 AND emoji = ?3`,
	)
		.bind(actorAccountId, status.id, emoji)
		.run();
}

async function undoBlock(
	actorAccountId: string,
	targetUri: string | null,
	env: Env,
): Promise<void> {
	if (!targetUri) {
		console.warn('[undo] Cannot undo block without target URI');
		return;
	}

	const targetAccount = await env.DB.prepare(
		`SELECT id FROM accounts WHERE uri = ?1 LIMIT 1`,
	)
		.bind(targetUri)
		.first<{ id: string }>();

	if (!targetAccount) return;

	await env.DB.prepare(
		`DELETE FROM blocks WHERE account_id = ?1 AND target_account_id = ?2`,
	)
		.bind(actorAccountId, targetAccount.id)
		.run();
}
