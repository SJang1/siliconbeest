/**
 * Inbox Processor: Move
 *
 * Handles incoming Move activities. Records that the old account has
 * moved to a new account by setting moved_to_account_id. Optionally
 * re-follows the new account for local followers (queued for later).
 */

import type { Env } from '../../env';
import type { APActivity } from '../../types/activitypub';
import { resolveRemoteAccount } from '../resolveRemoteAccount';
import { buildFollowActivity } from '../activityBuilder';

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
	const newAccountId = await resolveRemoteAccount(newAccountUri, env);
	if (!newAccountId) {
		console.error('[move] Could not resolve new account');
		return;
	}
	const newAccount = { id: newAccountId };

	// Set moved_to_account_id on the old account
	const now = new Date().toISOString();
	await env.DB.prepare(
		`UPDATE accounts SET moved_to_account_id = ?1, updated_at = ?2 WHERE id = ?3`,
	)
		.bind(newAccount.id, now, oldAccount.id)
		.run();

	// Re-follow: for each local follower of the old account, enqueue a Follow
	// activity to the new account so they automatically migrate.
	try {
		const { results: localFollowers } = await env.DB.prepare(
			`SELECT a.id, a.uri, a.username
			 FROM follows f
			 JOIN accounts a ON a.id = f.account_id
			 WHERE f.target_account_id = ?1 AND a.domain IS NULL`,
		)
			.bind(oldAccount.id)
			.all<{ id: string; uri: string; username: string }>();

		const newActorAccount = await env.DB.prepare(
			`SELECT uri, inbox_url, shared_inbox_url, domain FROM accounts WHERE id = ?1 LIMIT 1`,
		)
			.bind(newAccount.id)
			.first<{ uri: string; inbox_url: string | null; shared_inbox_url: string | null; domain: string | null }>();

		if (newActorAccount && localFollowers) {
			const newInbox = newActorAccount.inbox_url || newActorAccount.shared_inbox_url || `https://${newActorAccount.domain}/inbox`;
			for (const follower of localFollowers) {
				const followActivity = buildFollowActivity(follower.uri, newActorAccount.uri);
				await env.QUEUE_FEDERATION.send({
					type: 'deliver_activity',
					activity: followActivity,
					inboxUrl: newInbox,
					actorAccountId: follower.id,
				});
			}
			console.log(`[move] Enqueued re-follow for ${localFollowers.length} local followers: ${oldAccountUri} -> ${newAccountUri}`);
		}
	} catch (err) {
		console.error(`[move] Error enqueuing re-follows:`, err);
	}

	console.log(`[move] Recorded move: ${oldAccountUri} -> ${newAccountUri}`);
}
