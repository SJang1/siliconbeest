/**
 * Fedify Send Activity Helper
 *
 * Provides a simple interface for sending ActivityPub activities
 * from Hono route handlers using Fedify's delivery pipeline.
 *
 * Fedify handles:
 * - HTTP Signatures (RFC 9421 + draft-cavage)
 * - Linked Data Signatures
 * - Object Integrity Proofs (FEP-8b32)
 * - Follower resolution for fanout
 * - Queue-based async delivery via WorkersMessageQueue
 */

import { env } from 'cloudflare:workers';
import type { Federation, Context } from '@fedify/fedify';
import type { Activity, Recipient } from '@fedify/fedify/vocab';
import type { FedifyContextData } from '../fedify';

/**
 * Get a Fedify Context from a Federation instance for sending activities.
 *
 * Usage in Hono route handlers:
 * ```typescript
 * const fed = c.get('federation');
 * const ctx = getFedifyContext(fed);
 * await ctx.sendActivity(
 *   { identifier: currentAccount.username },
 *   "followers",
 *   activity,
 * );
 * ```
 */
export function getFedifyContext(
	federation: Federation<FedifyContextData>,
): Context<FedifyContextData> {
	return federation.createContext(
		new URL(`https://${env.INSTANCE_DOMAIN}`),
		{ env },
	);
}

/**
 * Send an activity to followers using Fedify's delivery pipeline.
 *
 * This is the Fedify replacement for `enqueueFanout()`.
 * Fedify resolves all followers, deduplicates inboxes, signs the
 * activity, and delivers via the queue.
 *
 * @param federation - The Federation instance from c.get('federation')
 * @param senderUsername - The local username of the sending actor
 * @param activity - The Fedify Activity object to send
 */
export async function sendToFollowers(
	federation: Federation<FedifyContextData>,
	senderUsername: string,
	activity: Activity,
): Promise<void> {
	console.log(`[federation] sendToFollowers: sender=${senderUsername}, activity.type=${activity.constructor.name}`);
	try {
		const ctx = getFedifyContext(federation);
		await ctx.sendActivity(
			{ identifier: senderUsername },
			'followers',
			activity,
		);
		console.log(`[federation] sendToFollowers: enqueued successfully`);
	} catch (err) {
		console.error(`[federation] sendToFollowers error:`, err);
		// Don't throw — federation failure shouldn't block the API response
	}
}

/**
 * Send an activity to a specific inbox using Fedify's delivery pipeline.
 *
 * This is the Fedify replacement for `enqueueDelivery()`.
 * Fedify signs the activity and delivers to the specified recipient.
 *
 * @param federation - The Federation instance from c.get('federation')
 * @param senderUsername - The local username of the sending actor
 * @param recipientUri - The ActivityPub URI of the recipient actor
 * @param activity - The Fedify Activity object to send
 */
export async function sendToRecipient(
	federation: Federation<FedifyContextData>,
	senderUsername: string,
	recipientUri: string,
	activity: Activity,
): Promise<void> {
	const ctx = getFedifyContext(federation);
	// Look up the recipient's inbox from the database
	const account = await env.DB.prepare(
		'SELECT inbox_url, shared_inbox_url FROM accounts WHERE uri = ?1 LIMIT 1',
	).bind(recipientUri).first<{ inbox_url: string; shared_inbox_url: string }>();
	if (!account?.inbox_url) {
		console.warn(`sendToRecipient: no inbox found for ${recipientUri}`);
		return;
	}
	const recipient: Recipient = {
		id: new URL(recipientUri),
		inboxId: new URL(account.inbox_url),
		endpoints: account.shared_inbox_url
			? { sharedInbox: new URL(account.shared_inbox_url) }
			: null,
	};
	await ctx.sendActivity(
		{ identifier: senderUsername },
		recipient,
		activity,
	);
}
