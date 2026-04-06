/**
 * Inbox Processor: Delete
 *
 * Handles incoming Delete activities. If the object is a status URI
 * (or Tombstone), soft-deletes the status. If the actor URI matches
 * the object, treats it as an actor deletion (account suspension).
 * Also removes related home_timeline_entries.
 */

import type { APActivity, APObject } from '../../types/activitypub';
import { BaseProcessor } from './BaseProcessor';
import { env } from 'cloudflare:workers';

class DeleteProcessor extends BaseProcessor {
	async process(activity: APActivity): Promise<void> {
		const object = activity.object;
		if (!object) {
			console.warn('[delete] activity.object is missing');
			return;
		}

		const now = new Date().toISOString();

		// Determine the URI of the deleted object
		let objectUri: string | undefined;
		if (typeof object === 'string') {
			objectUri = object;
		} else {
			objectUri = (object as APObject).id;
		}

		if (!objectUri) {
			console.warn('[delete] Could not determine object URI');
			return;
		}

		const actorAccount = await this.findAccountByUri(activity.actor);
		if (!actorAccount) {
			console.warn(`[delete] Actor not found: ${activity.actor}`);
			return;
		}

		// Check if this is an actor self-deletion (actor URI == object URI)
		if (objectUri === actorAccount.uri) {
			// Suspend the account
			await this.accountRepo.update(actorAccount.id, { suspended_at: now });

			// Soft-delete all their statuses
			await this.statusRepo.softDeleteByAccount(actorAccount.id);

			// Remove from home timelines
			await env.DB.prepare(
				`DELETE FROM home_timeline_entries
				 WHERE status_id IN (SELECT id FROM statuses WHERE account_id = ?1)`,
			)
				.bind(actorAccount.id)
				.run();

			console.log(`[delete] Suspended account: ${activity.actor}`);
			return;
		}

		// Otherwise, delete a specific status
		const status = await env.DB.prepare(
			`SELECT id, account_id, in_reply_to_id, reblog_of_id FROM statuses
			 WHERE uri = ?1 AND deleted_at IS NULL LIMIT 1`,
		)
			.bind(objectUri)
			.first<{
				id: string;
				account_id: string;
				in_reply_to_id: string | null;
				reblog_of_id: string | null;
			}>();

		if (!status) return;

		// Verify the actor owns the status
		if (status.account_id !== actorAccount.id) {
			console.warn('[delete] Actor does not own the status being deleted');
			return;
		}

		// Soft-delete the status
		await this.statusRepo.delete(status.id);

		// Decrement parent's replies_count if this was a reply
		if (status.in_reply_to_id) {
			await this.statusRepo.decrementCount(status.in_reply_to_id, 'replies_count');
		}

		// Decrement original's reblogs_count if this was a reblog
		if (status.reblog_of_id) {
			await this.statusRepo.decrementCount(status.reblog_of_id, 'reblogs_count');
		}

		// Remove from home timelines
		await env.DB.prepare(
			`DELETE FROM home_timeline_entries WHERE status_id = ?1`,
		)
			.bind(status.id)
			.run();
	}
}

export async function processDelete(
	activity: APActivity,
	_localAccountId: string,
): Promise<void> {
	await new DeleteProcessor().process(activity);
}
