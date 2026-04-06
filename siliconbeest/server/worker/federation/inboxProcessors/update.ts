/**
 * Inbox Processor: Update
 *
 * Handles incoming Update activities. If the object is a Person/Actor,
 * updates the cached account profile. If the object is a Note, updates
 * the cached status content and creates an 'update' notification for
 * local users who interacted with the post.
 */

import type { APActivity, APObject, APActor } from '../../types/activitypub';
import type { UpdateAccountInput } from '../../repositories/account';
import { sanitizeHtml } from '../../utils/sanitize';
import { BaseProcessor } from './BaseProcessor';
import { env } from 'cloudflare:workers';

class UpdateProcessor extends BaseProcessor {
	async process(activity: APActivity): Promise<void> {
		const object = activity.object;
		if (!object || typeof object === 'string') {
			console.warn('[update] activity.object is missing or a bare URI');
			return;
		}

		const obj = object as APObject;
		const now = new Date().toISOString();

		const actorAccount = await this.findAccountByUri(activity.actor);
		if (!actorAccount) {
			console.warn(`[update] Actor not found: ${activity.actor}`);
			return;
		}

		// Handle Person / Actor update
		const actorTypes = ['Person', 'Service', 'Application', 'Group', 'Organization'];
		if (actorTypes.includes(obj.type)) {
			const actor = obj as APActor;

			if (actor.id && actor.id !== activity.actor) {
				console.warn('[update] Actor URI mismatch — cannot update another actor');
				return;
			}

			const updates: UpdateAccountInput = {};

			if (actor.name !== undefined) updates.display_name = actor.name ?? '';
			if (actor.summary !== undefined) updates.note = sanitizeHtml(actor.summary ?? '');
			if (actor.icon?.url) {
				updates.avatar_url = actor.icon.url;
				updates.avatar_static_url = actor.icon.url;
			}
			if (actor.image?.url) {
				updates.header_url = actor.image.url;
				updates.header_static_url = actor.image.url;
			}
			if (actor.manuallyApprovesFollowers !== undefined) {
				updates.manually_approves_followers = actor.manuallyApprovesFollowers ? 1 : 0;
			}
			if (actor.discoverable !== undefined) {
				updates.discoverable = actor.discoverable ? 1 : 0;
			}
			if (actor.url !== undefined) {
				updates.url = typeof actor.url === 'string' ? actor.url : null;
			}

			if (Object.keys(updates).length === 0) return;

			await this.accountRepo.update(actorAccount.id, updates);
			return;
		}

		// Handle Note update
		if (obj.type === 'Note') {
			if (!obj.id) {
				console.warn('[update] Note has no id');
				return;
			}

			const status = await this.statusRepo.findByUri(obj.id);
			if (!status) {
				console.log(`[update] Status not found: ${obj.id}`);
				return;
			}

			if (status.account_id !== actorAccount.id) {
				console.warn('[update] Actor does not own the status being updated');
				return;
			}

			const sanitizedContent = sanitizeHtml(obj.content ?? '');
			const sanitizedCw = sanitizeHtml(obj.summary ?? '');

			await this.statusRepo.update(status.id, {
				content: sanitizedContent,
				content_warning: sanitizedCw,
				sensitive: obj.sensitive ? 1 : 0,
				edited_at: now,
			});

			// Notify local users who interacted with this status
			const interactedUsers = await env.DB.prepare(
				`SELECT DISTINCT account_id FROM (
					SELECT account_id FROM favourites WHERE status_id = ?1
					UNION
					SELECT account_id FROM statuses WHERE reblog_of_id = ?1 AND deleted_at IS NULL
					UNION
					SELECT account_id FROM bookmarks WHERE status_id = ?1
				) sub
				JOIN accounts a ON a.id = sub.account_id
				WHERE a.domain IS NULL AND sub.account_id != ?2`,
			)
				.bind(status.id, actorAccount.id)
				.all<{ account_id: string }>();

			if (interactedUsers.results) {
				for (const user of interactedUsers.results) {
					await this.notify('update', user.account_id, actorAccount.id, status.id);
				}
			}
		}
	}
}

export async function processUpdate(
	activity: APActivity,
	_localAccountId: string,
): Promise<void> {
	await new UpdateProcessor().process(activity);
}
