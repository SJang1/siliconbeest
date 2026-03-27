/**
 * Inbox Processor: Accept(Follow)
 *
 * Handles incoming Accept activities, confirming that a remote actor
 * has accepted our outgoing follow request. Moves the pending request
 * from follow_requests to follows and updates counts.
 */

import type { Env } from '../../env';
import type { APActivity, APObject } from '../../types/activitypub';
import { generateUlid } from '../../utils/ulid';

export async function processAccept(
	activity: APActivity,
	_localAccountId: string,
	env: Env,
): Promise<void> {
	// The object should be the Follow activity we originally sent
	const object = activity.object;
	if (!object) {
		console.warn('[accept] activity.object is missing');
		return;
	}

	// ------------------------------------------------------------------
	// Relay Accept handling — check if this Accept is for a relay Follow
	// ------------------------------------------------------------------
	const followId = typeof object === 'string' ? object : (object as APObject).id;
	if (followId) {
		const relay = await env.DB.prepare(
			'SELECT id FROM relays WHERE follow_activity_id = ?1',
		)
			.bind(followId)
			.first<{ id: string }>();

		if (relay) {
			// Update relay state to accepted
			await env.DB.prepare(
				"UPDATE relays SET state = 'accepted', actor_uri = ?1, updated_at = ?2 WHERE id = ?3",
			)
				.bind(String(activity.actor), new Date().toISOString(), relay.id)
				.run();
			return; // Don't process as regular follow accept
		}
	}

	// Resolve the remote actor who is accepting (= the target of our follow)
	const remoteAccount = await env.DB.prepare(
		`SELECT id FROM accounts WHERE uri = ?1 LIMIT 1`,
	)
		.bind(activity.actor)
		.first<{ id: string }>();

	if (!remoteAccount) {
		console.warn(`[accept] Remote actor not found: ${activity.actor}`);
		return;
	}

	// Try to find the pending follow_request.
	// The object may be a Follow object with an id, or a string URI.
	let followRequest: { id: string; account_id: string; target_account_id: string; uri: string | null } | null = null;

	if (typeof object === 'string') {
		// Object is a URI referencing the original Follow activity
		followRequest = await env.DB.prepare(
			`SELECT id, account_id, target_account_id, uri FROM follow_requests
			 WHERE uri = ?1 LIMIT 1`,
		)
			.bind(object)
			.first();
	} else {
		const obj = object as APObject;
		if (obj.id) {
			followRequest = await env.DB.prepare(
				`SELECT id, account_id, target_account_id, uri FROM follow_requests
				 WHERE uri = ?1 LIMIT 1`,
			)
				.bind(obj.id)
				.first();
		}
	}

	// Fallback: find by account pair (our local account -> remote account)
	if (!followRequest) {
		followRequest = await env.DB.prepare(
			`SELECT id, account_id, target_account_id, uri FROM follow_requests
			 WHERE target_account_id = ?1
			 AND account_id IN (SELECT id FROM accounts WHERE domain IS NULL)
			 LIMIT 1`,
		)
			.bind(remoteAccount.id)
			.first();
	}

	if (!followRequest) {
		console.warn('[accept] No matching follow_request found');
		return;
	}

	const now = new Date().toISOString();
	const newFollowId = generateUlid();

	// Move from follow_requests to follows
	try {
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO follows (id, account_id, target_account_id, uri, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
			).bind(
				newFollowId,
				followRequest.account_id,
				followRequest.target_account_id,
				followRequest.uri,
				now,
				now,
			),
			env.DB.prepare(
				`DELETE FROM follow_requests WHERE id = ?1`,
			).bind(followRequest.id),
			env.DB.prepare(
				`UPDATE accounts SET following_count = following_count + 1 WHERE id = ?1`,
			).bind(followRequest.account_id),
			env.DB.prepare(
				`UPDATE accounts SET followers_count = followers_count + 1 WHERE id = ?1`,
			).bind(followRequest.target_account_id),
		]);
	} catch (err) {
		console.error('[accept] Failed to move follow_request to follows:', err);
	}
}
