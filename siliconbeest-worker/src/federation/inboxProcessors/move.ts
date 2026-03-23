/**
 * Inbox Processor: Move
 *
 * Handles incoming Move activities. Records that the old account has
 * moved to a new account by setting moved_to_account_id. Optionally
 * re-follows the new account for local followers (queued for later).
 */

import type { Env } from '../../env';
import type { APActivity } from '../../types/activitypub';
import { generateUlid } from '../../utils/ulid';

export async function processMove(
	activity: APActivity,
	_localAccountId: string,
	env: Env,
): Promise<void> {
	// activity.object = old account URI, activity.target = new account URI
	const oldAccountUri =
		typeof activity.object === 'string' ? activity.object : undefined;
	const newAccountUri =
		typeof activity.target === 'string' ? activity.target : undefined;

	if (!oldAccountUri || !newAccountUri) {
		console.warn('[move] Missing object or target URI');
		return;
	}

	// Verify the actor matches the old account
	if (activity.actor !== oldAccountUri) {
		console.warn('[move] Actor does not match old account URI');
		return;
	}

	// Resolve the old account
	const oldAccount = await env.DB.prepare(
		`SELECT id FROM accounts WHERE uri = ?1 LIMIT 1`,
	)
		.bind(oldAccountUri)
		.first<{ id: string }>();

	if (!oldAccount) {
		console.warn(`[move] Old account not found: ${oldAccountUri}`);
		return;
	}

	// Resolve or stub the new account
	let newAccount = await env.DB.prepare(
		`SELECT id FROM accounts WHERE uri = ?1 LIMIT 1`,
	)
		.bind(newAccountUri)
		.first<{ id: string }>();

	if (!newAccount) {
		// Insert a stub for the new account
		const now = new Date().toISOString();
		const id = generateUlid();
		let username = 'unknown';
		let domain = 'unknown';

		try {
			const url = new URL(newAccountUri);
			domain = url.host;
			const segments = url.pathname.split('/').filter(Boolean);
			username = segments[segments.length - 1] ?? 'unknown';
		} catch {
			// leave defaults
		}

		try {
			await env.DB.prepare(
				`INSERT INTO accounts (id, username, domain, uri, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
			)
				.bind(id, username, domain, newAccountUri, now, now)
				.run();
			newAccount = { id };
		} catch {
			const retry = await env.DB.prepare(
				`SELECT id FROM accounts WHERE uri = ?1 LIMIT 1`,
			)
				.bind(newAccountUri)
				.first<{ id: string }>();
			if (!retry) {
				console.error('[move] Could not create new account stub');
				return;
			}
			newAccount = retry;
		}

		// Fetch the full profile for the new account
		await env.QUEUE_FEDERATION.send({
			type: 'fetch_remote_account',
			actorUri: newAccountUri,
		});
	}

	// Set moved_to_account_id on the old account
	const now = new Date().toISOString();
	await env.DB.prepare(
		`UPDATE accounts SET moved_to_account_id = ?1, updated_at = ?2 WHERE id = ?3`,
	)
		.bind(newAccount.id, now, oldAccount.id)
		.run();

	// TODO: For each local follower of the old account, enqueue a follow
	// of the new account. This is complex (needs alsoKnownAs verification)
	// and should be implemented as a separate queue job.
	console.log(`[move] Recorded move: ${oldAccountUri} -> ${newAccountUri}`);
}
