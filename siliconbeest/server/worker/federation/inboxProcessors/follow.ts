/**
 * Inbox Processor: Follow
 *
 * Handles incoming Follow activities. If the target account is locked
 * the follow goes into follow_requests; otherwise it is auto-accepted
 * and an Accept(Follow) is sent back.
 */

import type { Env } from '../../env';
import type { APActivity } from '../../types/activitypub';
import { generateUlid } from '../../utils/ulid';
import { buildAcceptActivity } from '../helpers/build-activity';
import { resolveRemoteAccount } from '../resolveRemoteAccount';
import { AccountRepository } from '../../repositories/account';

export async function processFollow(
	activity: APActivity,
	_localAccountId: string,
	env: Env,
): Promise<void> {
	const targetUri =
		typeof activity.object === 'string' ? activity.object : undefined;

	if (!targetUri) {
		console.warn('[follow] activity.object is not a string URI');
		return;
	}

	const accountRepo = new AccountRepository(env.DB);

	// Resolve the local target account
	const targetAccount = await accountRepo.findLocalByUri(targetUri);
	if (!targetAccount) {
		console.warn(`[follow] Target account not found locally: ${targetUri}`);
		return;
	}

	// Resolve the remote follower
	const followerAccountId = await resolveRemoteAccount(activity.actor, env);
	if (!followerAccountId) {
		console.error('[follow] Could not resolve remote follower');
		return;
	}

	const now = new Date().toISOString();

	if (targetAccount.manually_approves_followers) {
		// Insert follow request
		const requestId = generateUlid();
		try {
			await env.DB.prepare(
				`INSERT INTO follow_requests (id, account_id, target_account_id, uri, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
			)
				.bind(requestId, followerAccountId, targetAccount.id, activity.id ?? null, now, now)
				.run();
		} catch {
			// Duplicate follow request, ignore
			return;
		}

		// Notify target about the follow request
		await env.QUEUE_INTERNAL.send({
			type: 'create_notification',
			recipientAccountId: targetAccount.id,
			senderAccountId: followerAccountId,
			notificationType: 'follow_request',
		});
	} else {
		// Auto-accept: insert directly into follows
		const followId = generateUlid();
		try {
			await env.DB.prepare(
				`INSERT INTO follows (id, account_id, target_account_id, uri, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
			)
				.bind(followId, followerAccountId, targetAccount.id, activity.id ?? null, now, now)
				.run();
		} catch {
			// Duplicate follow, ignore
			return;
		}

		// Update follower/following counts
		await accountRepo.incrementCount(targetAccount.id, 'followers_count');
		await accountRepo.incrementCount(followerAccountId, 'following_count');

		// Notify target about the new follower
		await env.QUEUE_INTERNAL.send({
			type: 'create_notification',
			recipientAccountId: targetAccount.id,
			senderAccountId: followerAccountId,
			notificationType: 'follow',
		});

		// Send Accept(Follow) back to the follower's inbox
		const acceptJson = await buildAcceptActivity(targetAccount.uri, activity as unknown as Record<string, unknown>, activity.actor);

		// Look up the remote actor's inbox to deliver the Accept
		const remoteActor = await accountRepo.findById(followerAccountId);
		if (remoteActor) {
			const followerInbox = remoteActor.inbox_url
				|| remoteActor.shared_inbox_url
				|| `https://${remoteActor.domain}/inbox`;

			await env.QUEUE_FEDERATION.send({
				type: 'deliver_activity',
				activity: JSON.parse(acceptJson),
				inboxUrl: followerInbox,
				actorAccountId: targetAccount.id,
			});
		}
	}
}
