/**
 * Inbox Processor: Move
 *
 * Handles incoming Move activities. Records that the old account has
 * moved to a new account by setting moved_to_account_id. Creates
 * notifications for local followers and enqueues re-follow activities.
 */

import type { APActivity } from '../../types/activitypub';
import { buildFollowActivity } from '../helpers/build-activity';
import { createFed } from '../fedify';
import { getFedifyContext } from '../helpers/send';
import { isActor } from '@fedify/fedify/vocab';
import { generateUlid } from '../../utils/ulid';
import { BaseProcessor } from './BaseProcessor';
import { env } from 'cloudflare:workers';

class MoveProcessor extends BaseProcessor {
	async process(activity: APActivity): Promise<void> {
		const oldAccountUri =
			typeof activity.object === 'string' ? activity.object : undefined;
		const newAccountUri =
			typeof activity.target === 'string' ? activity.target : undefined;

		if (!oldAccountUri || !newAccountUri) {
			console.warn('[move] Missing object or target URI');
			return;
		}

		if (activity.actor !== oldAccountUri) {
			console.warn('[move] Actor does not match old account URI');
			return;
		}

		// Bidirectional verification via Fedify
		const fed = createFed();
		const ctx = getFedifyContext(fed);
		const localAcct = await env.DB.prepare("SELECT username FROM accounts WHERE domain IS NULL LIMIT 1").first<{ username: string }>();
		const docLoader = await ctx.getDocumentLoader({ identifier: localAcct?.username || 'admin' });
		const newActorObj = await ctx.lookupObject(newAccountUri, { documentLoader: docLoader });
		if (!newActorObj || !isActor(newActorObj) || !newActorObj.id) {
			console.warn(`[move] Could not fetch new account actor document: ${newAccountUri}`);
			return;
		}

		const alsoKnownAs: string[] = newActorObj.aliasIds
			? Array.from(newActorObj.aliasIds).map((u: URL) => u.href)
			: [];

		if (!alsoKnownAs.includes(oldAccountUri)) {
			console.warn(`[move] Rejecting Move: new account ${newAccountUri} does not list ${oldAccountUri} in alsoKnownAs`);
			return;
		}

		const oldAccount = await this.findAccountByUri(oldAccountUri);
		if (!oldAccount) {
			console.warn(`[move] Old account not found: ${oldAccountUri}`);
			return;
		}

		const newAccountId = await this.resolveActor(newAccountUri);
		if (!newAccountId) {
			console.error('[move] Could not resolve new account');
			return;
		}

		// Set moved_to_account_id on the old account
		await this.accountRepo.update(oldAccount.id, { moved_to_account_id: newAccountId });

		// Create notifications for local followers and enqueue re-follows
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
				const now = new Date().toISOString();
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

			// Re-follow: enqueue Follow activity to the new account for each local follower
			const newActorAccount = await this.accountRepo.findById(newAccountId);
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
}

export async function processMove(
	activity: APActivity,
	_localAccountId: string,
): Promise<void> {
	await new MoveProcessor().process(activity);
}
