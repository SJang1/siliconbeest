/**
 * Inbox Processor: Announce (boost/reblog)
 *
 * Handles incoming Announce activities. Creates a reblog status,
 * increments reblogs_count on the original, creates a notification
 * for the original author, and fans out to local followers.
 */

import type { Env } from '../../env';
import type { APActivity } from '../../types/activitypub';
import { generateUlid } from '../../utils/ulid';
import { resolveRemoteAccount } from '../resolveRemoteAccount';

export async function processAnnounce(
	activity: APActivity,
	_localAccountId: string,
	env: Env,
): Promise<void> {
	// ------------------------------------------------------------------
	// Relay Announce handling — relay actors forward public posts
	// ------------------------------------------------------------------
	const relay = await env.DB.prepare(
		"SELECT id FROM relays WHERE actor_uri = ?1 AND state = 'accepted'",
	)
		.bind(String(activity.actor))
		.first();

	if (relay) {
		// Relay Announce: extract the original Note and enqueue fetch
		const objectUri =
			typeof activity.object === 'string' ? activity.object : undefined;
		if (objectUri) {
			await env.QUEUE_FEDERATION.send({
				type: 'fetch_remote_status',
				statusUri: objectUri,
			});
		}
		return; // Don't process as regular boost
	}

	const statusUri =
		typeof activity.object === 'string' ? activity.object : undefined;

	if (!statusUri) {
		console.warn('[announce] activity.object is not a string URI');
		return;
	}

	// Find the original status being boosted
	const originalStatus = await env.DB.prepare(
		`SELECT id, account_id FROM statuses WHERE uri = ?1 LIMIT 1`,
	)
		.bind(statusUri)
		.first<{ id: string; account_id: string }>();

	if (!originalStatus) {
		console.log(`[announce] Original status not found: ${statusUri}`);
		return;
	}

	// Resolve the remote booster
	const boosterAccountId = await resolveRemoteAccount(activity.actor, env);
	if (!boosterAccountId) {
		console.error('[announce] Could not resolve remote actor');
		return;
	}

	// Check for duplicate reblog
	const existingReblog = await env.DB.prepare(
		`SELECT id FROM statuses
		 WHERE reblog_of_id = ?1 AND account_id = ?2 AND deleted_at IS NULL
		 LIMIT 1`,
	)
		.bind(originalStatus.id, boosterAccountId)
		.first();

	if (existingReblog) {
		return; // Already boosted
	}

	const now = new Date().toISOString();
	const reblogId = generateUlid();
	const reblogUri = activity.id ?? `${activity.actor}/statuses/${reblogId}`;

	// Create the reblog status
	await env.DB.prepare(
		`INSERT INTO statuses
		 (id, uri, account_id, reblog_of_id, visibility, local, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, 'public', 0, ?5, ?6)`,
	)
		.bind(reblogId, reblogUri, boosterAccountId, originalStatus.id, now, now)
		.run();

	// Increment reblogs_count on the original
	await env.DB.prepare(
		`UPDATE statuses SET reblogs_count = reblogs_count + 1 WHERE id = ?1`,
	)
		.bind(originalStatus.id)
		.run();

	// Create notification for the original author (only if local)
	const isLocalAuthor = await env.DB.prepare(
		`SELECT id FROM accounts WHERE id = ?1 AND domain IS NULL LIMIT 1`,
	)
		.bind(originalStatus.account_id)
		.first();

	if (isLocalAuthor) {
		await env.QUEUE_INTERNAL.send({
			type: 'create_notification',
			recipientAccountId: originalStatus.account_id,
			senderAccountId: boosterAccountId,
			notificationType: 'reblog',
			statusId: originalStatus.id,
		});
	}

	// Fan out to local followers of the booster
	await env.QUEUE_INTERNAL.send({
		type: 'timeline_fanout',
		statusId: reblogId,
		accountId: boosterAccountId,
	});
}
