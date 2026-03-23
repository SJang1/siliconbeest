/**
 * Inbox Processor: Delete
 *
 * Handles incoming Delete activities. If the object is a status URI
 * (or Tombstone), soft-deletes the status. If the actor URI matches
 * the object, treats it as an actor deletion (account suspension).
 * Also removes related home_timeline_entries.
 */

import type { Env } from '../../env';
import type { APActivity, APObject } from '../../types/activitypub';

export async function processDelete(
	activity: APActivity,
	_localAccountId: string,
	env: Env,
): Promise<void> {
	const object = activity.object;
	if (!object) {
		console.warn('[delete] activity.object is missing');
		return;
	}

	const now = new Date().toISOString();

	// Determine the URI of the deleted object
	let objectUri: string | undefined;

	if (typeof object === 'string') {
		objectUri = object;
	} else {
		const obj = object as APObject;
		objectUri = obj.id;
	}

	if (!objectUri) {
		console.warn('[delete] Could not determine object URI');
		return;
	}

	// Verify the actor owns the object being deleted
	const actorAccount = await env.DB.prepare(
		`SELECT id, uri FROM accounts WHERE uri = ?1 LIMIT 1`,
	)
		.bind(activity.actor)
		.first<{ id: string; uri: string }>();

	if (!actorAccount) {
		console.warn(`[delete] Actor not found: ${activity.actor}`);
		return;
	}

	// Check if this is an actor self-deletion (actor URI == object URI)
	if (objectUri === actorAccount.uri) {
		// Suspend the account
		await env.DB.prepare(
			`UPDATE accounts SET suspended_at = ?1, updated_at = ?2 WHERE id = ?3`,
		)
			.bind(now, now, actorAccount.id)
			.run();

		// Soft-delete all their statuses
		await env.DB.prepare(
			`UPDATE statuses SET deleted_at = ?1 WHERE account_id = ?2 AND deleted_at IS NULL`,
		)
			.bind(now, actorAccount.id)
			.run();

		// Remove from home timelines
		await env.DB.prepare(
			`DELETE FROM home_timeline_entries
			 WHERE status_id IN (SELECT id FROM statuses WHERE account_id = ?1)`,
		)
			.bind(actorAccount.id)
			.run();

		console.log(`[delete] Suspended account: ${activity.actor}`);
		return;
	}

	// Otherwise, delete a specific status
	const status = await env.DB.prepare(
		`SELECT id, account_id, in_reply_to_id, reblog_of_id FROM statuses
		 WHERE uri = ?1 AND deleted_at IS NULL LIMIT 1`,
	)
		.bind(objectUri)
		.first<{
			id: string;
			account_id: string;
			in_reply_to_id: string | null;
			reblog_of_id: string | null;
		}>();

	if (!status) {
		return; // Status not found or already deleted
	}

	// Verify the actor owns the status
	if (status.account_id !== actorAccount.id) {
		console.warn('[delete] Actor does not own the status being deleted');
		return;
	}

	// Soft-delete the status
	await env.DB.prepare(
		`UPDATE statuses SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3`,
	)
		.bind(now, now, status.id)
		.run();

	// Decrement parent's replies_count if this was a reply
	if (status.in_reply_to_id) {
		await env.DB.prepare(
			`UPDATE statuses SET replies_count = MAX(0, replies_count - 1) WHERE id = ?1`,
		)
			.bind(status.in_reply_to_id)
			.run();
	}

	// Decrement original's reblogs_count if this was a reblog
	if (status.reblog_of_id) {
		await env.DB.prepare(
			`UPDATE statuses SET reblogs_count = MAX(0, reblogs_count - 1) WHERE id = ?1`,
		)
			.bind(status.reblog_of_id)
			.run();
	}

	// Remove from home timelines
	await env.DB.prepare(
		`DELETE FROM home_timeline_entries WHERE status_id = ?1`,
	)
		.bind(status.id)
		.run();
}
