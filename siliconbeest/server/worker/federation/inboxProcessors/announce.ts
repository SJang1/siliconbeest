/**
 * Inbox Processor: Announce (boost/reblog)
 *
 * Handles incoming Announce activities. Creates a reblog status,
 * increments reblogs_count on the original, creates a notification
 * for the original author, and fans out to local followers.
 */
import { env } from 'cloudflare:workers';
import type { APActivity } from '../../types/activitypub';
import { BaseProcessor } from './BaseProcessor';

class AnnounceProcessor extends BaseProcessor {
	async process(activity: APActivity): Promise<void> {
		// Relay Announce handling
		const relay = await env.DB.prepare(
			"SELECT id FROM relays WHERE actor_uri = ?1 AND state = 'accepted'",
		)
			.bind(String(activity.actor))
			.first();

		if (relay) {
			const objectUri = this.extractObjectUri(activity);
			if (objectUri) {
				await env.QUEUE_FEDERATION.send({
					type: 'fetch_remote_status',
					statusUri: objectUri,
				});
			}
			return;
		}

		const statusUri = this.extractObjectUri(activity);
		if (!statusUri) {
			console.warn('[announce] activity.object is not a string URI');
			return;
		}

		const originalStatus = await this.findStatusByUri(statusUri);
		if (!originalStatus) {
			console.log(`[announce] Original status not found: ${statusUri}`);
			return;
		}

		const boosterAccountId = await this.resolveActor(activity.actor);
		if (!boosterAccountId) {
			console.error('[announce] Could not resolve remote actor');
			return;
		}

		// Check for duplicate reblog
		const existingReblog = await env.DB.prepare(
			`SELECT id FROM statuses
			 WHERE reblog_of_id = ?1 AND account_id = ?2 AND deleted_at IS NULL
			 LIMIT 1`,
		)
			.bind(originalStatus.id, boosterAccountId)
			.first();

		if (existingReblog) return;

		const reblogUri = activity.id ?? `${activity.actor}/statuses/${originalStatus.id}`;

		const reblog = await this.statusRepo.create({
			uri: reblogUri,
			account_id: boosterAccountId,
			reblog_of_id: originalStatus.id,
			visibility: 'public',
			local: 0,
		});

		await this.statusRepo.incrementCount(originalStatus.id, 'reblogs_count');
		await this.notifyIfLocal('reblog', originalStatus.account_id, boosterAccountId, originalStatus.id);

		await env.QUEUE_INTERNAL.send({
			type: 'timeline_fanout',
			statusId: reblog.id,
			accountId: boosterAccountId,
		});
	}
}

export async function processAnnounce(
	activity: APActivity,
	_localAccountId: string,
): Promise<void> {
	await new AnnounceProcessor().process(activity);
}
