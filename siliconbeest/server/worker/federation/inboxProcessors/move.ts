/**
 * Inbox Processor: Move
 *
 * Handles incoming Move activities. Records that the old account has
 * moved to a new account by setting moved_to_account_id. Optionally
 * re-follows the new account for local followers (queued for later).
 *
 * Security: Verifies that the new account's actor document contains
 * the old account URI in its alsoKnownAs array (bidirectional check).
 */

import type { Env } from '../../env';
import type { APActivity } from '../../types/activitypub';
import { resolveRemoteAccount } from '../resolveRemoteAccount';
import { buildFollowActivity } from '../helpers/build-activity';
import { createFed } from '../fedify';
import { getFedifyContext } from '../helpers/send';
import { isActor } from '@fedify/fedify/vocab';
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

	// ── Bidirectional verification ──
	// Fetch the new account's actor document via Fedify and verify alsoKnownAs
	const fed = createFed(env);
	const ctx = getFedifyContext(fed, env);
	const newActorObj = await ctx.lookupObject(newAccountUri);
	if (!newActorObj || !isActor(newActorObj) || !newActorObj.id) {
		console.warn(`[move] Could not fetch new account actor document: ${newAccountUri}`);
		return;
	}

	const alsoKnownAs: string[] = (newActorObj as any).aliasIds
		? Array.from((newActorObj as any).aliasIds).map((u: any) => typeof u === 'string' ? u : u.href)
		: [];

	if (!alsoKnownAs.includes(oldAccountUri)) {
		console.warn(
			`[move] Rejecting Move: new account ${newAccountUri} does not list ${oldAccountUri} in alsoKnownAs`,
		);
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

	// ── Create notifications for local followers ──
	try {
		const { results: localFollowers } = await env.DB.prepare(
			`SELECT a.id, a.uri, a.username
			 FROM follows f
			 JOIN accounts a ON a.id = f.account_id
			 WHERE f.target_account_id = ?1 AND a.domain IS NULL`,
		)
			.bind(oldAccount.id)
			.all<{ id: string; uri: string; username: string }>();

		if (localFollowers) {
			// Create move notifications for each local follower
			const notificationBatch = localFollowers.map((follower) =>
				env.DB.prepare(
					`INSERT OR IGNORE INTO notifications (id, account_id, from_account_id, type, created_at)
					 VALUES (?1, ?2, ?3, 'move', ?4)`,
				).bind(generateUlid(), follower.id, oldAccount.id, now),
			);

			if (notificationBatch.length > 0) {
				await env.DB.batch(notificationBatch);
			}
		}

		// Re-follow: for each local follower, enqueue a Follow activity to the new account
		const newActorAccount = await env.DB.prepare(
			`SELECT uri, inbox_url, shared_inbox_url, domain FROM accounts WHERE id = ?1 LIMIT 1`,
		)
			.bind(newAccount.id)
			.first<{ uri: string; inbox_url: string | null; shared_inbox_url: string | null; domain: string | null }>();

		if (newActorAccount && localFollowers) {
			const newInbox = newActorAccount.inbox_url || newActorAccount.shared_inbox_url || `https://${newActorAccount.domain}/inbox`;
			for (const follower of localFollowers) {
				const followJson = await buildFollowActivity(follower.uri, newActorAccount.uri);
				await env.QUEUE_FEDERATION.send({
					type: 'deliver_activity',
					activity: JSON.parse(followJson),
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
