/**
 * Inbox Processor: Reject(Follow)
 *
 * Handles incoming Reject activities. Removes the pending follow_request
 * that corresponds to a Follow we sent.
 */

import type { Env } from '../../env';
import type { APActivity, APObject } from '../../types/activitypub';

export async function processReject(
	activity: APActivity,
	_localAccountId: string,
	env: Env,
): Promise<void> {
	const object = activity.object;
	if (!object) {
		console.warn('[reject] activity.object is missing');
		return;
	}

	// Resolve the remote actor who is rejecting
	const remoteAccount = await env.DB.prepare(
		`SELECT id FROM accounts WHERE uri = ?1 LIMIT 1`,
	)
		.bind(activity.actor)
		.first<{ id: string }>();

	if (!remoteAccount) {
		console.warn(`[reject] Remote actor not found: ${activity.actor}`);
		return;
	}

	// Try to find the follow_request by URI
	let deleted = false;

	if (typeof object === 'string') {
		const result = await env.DB.prepare(
			`DELETE FROM follow_requests WHERE uri = ?1`,
		)
			.bind(object)
			.run();
		deleted = (result.meta?.changes ?? 0) > 0;
	} else {
		const obj = object as APObject;
		if (obj.id) {
			const result = await env.DB.prepare(
				`DELETE FROM follow_requests WHERE uri = ?1`,
			)
				.bind(obj.id)
				.run();
			deleted = (result.meta?.changes ?? 0) > 0;
		}
	}

	// Fallback: delete by account pair
	if (!deleted) {
		await env.DB.prepare(
			`DELETE FROM follow_requests
			 WHERE target_account_id = ?1
			 AND account_id IN (SELECT id FROM accounts WHERE domain IS NULL)`,
		)
			.bind(remoteAccount.id)
			.run();
	}
}
