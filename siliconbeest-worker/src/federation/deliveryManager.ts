/**
 * Delivery Manager
 *
 * Simple wrappers that enqueue typed messages to the federation queue
 * for asynchronous processing by the queue consumer.
 */

import type { QueueMessage } from '../types/queue';
import type { APActivity } from '../types/activitypub';

/**
 * Enqueue a single activity delivery to a specific inbox.
 *
 * @param queue - The QUEUE_FEDERATION producer binding
 * @param activityJson - The serialised ActivityPub activity JSON string
 * @param targetInbox - The inbox URL to deliver to
 * @param actorId - The account ID of the sending actor (used to look up signing keys)
 */
export async function enqueueDelivery(
	queue: Queue<QueueMessage>,
	activityJson: string,
	targetInbox: string,
	actorId: string,
): Promise<void> {
	const activity: APActivity = JSON.parse(activityJson);

	await queue.send({
		type: 'deliver_activity',
		activity,
		inboxUrl: targetInbox,
		actorAccountId: actorId,
	});
}

/**
 * Enqueue a fanout delivery to all followers of the sending actor.
 *
 * The queue consumer resolves the follower list and delivers to
 * each unique shared inbox / personal inbox.
 *
 * @param queue - The QUEUE_FEDERATION producer binding
 * @param activityJson - The serialised ActivityPub activity JSON string
 * @param actorId - The account ID of the sending actor
 */
export async function enqueueFanout(
	queue: Queue<QueueMessage>,
	activityJson: string,
	actorId: string,
): Promise<void> {
	const activity: APActivity = JSON.parse(activityJson);

	await queue.send({
		type: 'deliver_activity_fanout',
		activity,
		actorAccountId: actorId,
	});
}

/**
 * Enqueue a request to fetch and store a remote account.
 *
 * @param queue - The QUEUE_FEDERATION producer binding
 * @param uri - The ActivityPub actor URI to fetch
 */
export async function enqueueRemoteAccountFetch(
	queue: Queue<QueueMessage>,
	uri: string,
): Promise<void> {
	await queue.send({
		type: 'fetch_remote_account',
		actorUri: uri,
	});
}
