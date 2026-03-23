/**
 * Inbox Processor: Update
 *
 * Handles incoming Update activities. If the object is a Person/Actor,
 * updates the cached account profile. If the object is a Note, updates
 * the cached status content and creates an 'update' notification for
 * local followers.
 */

import type { Env } from '../../env';
import type { APActivity, APObject, APActor } from '../../types/activitypub';

export async function processUpdate(
	activity: APActivity,
	_localAccountId: string,
	env: Env,
): Promise<void> {
	const object = activity.object;
	if (!object || typeof object === 'string') {
		console.warn('[update] activity.object is missing or a bare URI');
		return;
	}

	const obj = object as APObject;
	const now = new Date().toISOString();

	// Verify the actor owns the object being updated
	const actorAccount = await env.DB.prepare(
		`SELECT id FROM accounts WHERE uri = ?1 LIMIT 1`,
	)
		.bind(activity.actor)
		.first<{ id: string }>();

	if (!actorAccount) {
		console.warn(`[update] Actor not found: ${activity.actor}`);
		return;
	}

	// Handle Person / Actor update
	const actorTypes = ['Person', 'Service', 'Application', 'Group', 'Organization'];
	if (actorTypes.includes(obj.type)) {
		const actor = obj as APActor;

		// Only allow updating the actor's own profile
		if (actor.id && actor.id !== activity.actor) {
			console.warn('[update] Actor URI mismatch — cannot update another actor');
			return;
		}

		const updates: string[] = [];
		const bindings: (string | null)[] = [];
		let bindIdx = 1;

		if (actor.name !== undefined) {
			updates.push(`display_name = ?${bindIdx++}`);
			bindings.push(actor.name ?? '');
		}
		if (actor.summary !== undefined) {
			updates.push(`note = ?${bindIdx++}`);
			bindings.push(actor.summary ?? '');
		}
		if (actor.icon?.url) {
			updates.push(`avatar_url = ?${bindIdx++}`);
			bindings.push(actor.icon.url);
			updates.push(`avatar_static_url = ?${bindIdx++}`);
			bindings.push(actor.icon.url);
		}
		if (actor.image?.url) {
			updates.push(`header_url = ?${bindIdx++}`);
			bindings.push(actor.image.url);
			updates.push(`header_static_url = ?${bindIdx++}`);
			bindings.push(actor.image.url);
		}
		if (actor.manuallyApprovesFollowers !== undefined) {
			updates.push(`manually_approves_followers = ?${bindIdx++}`);
			bindings.push(actor.manuallyApprovesFollowers ? '1' : '0');
		}
		if (actor.discoverable !== undefined) {
			updates.push(`discoverable = ?${bindIdx++}`);
			bindings.push(actor.discoverable ? '1' : '0');
		}
		if (actor.url !== undefined) {
			updates.push(`url = ?${bindIdx++}`);
			bindings.push(typeof actor.url === 'string' ? actor.url : null);
		}

		if (updates.length === 0) {
			return; // Nothing to update
		}

		updates.push(`updated_at = ?${bindIdx++}`);
		bindings.push(now);
		bindings.push(actorAccount.id); // WHERE clause

		const sql = `UPDATE accounts SET ${updates.join(', ')} WHERE id = ?${bindIdx}`;

		const stmt = env.DB.prepare(sql);
		await stmt.bind(...bindings).run();

		return;
	}

	// Handle Note update
	if (obj.type === 'Note') {
		if (!obj.id) {
			console.warn('[update] Note has no id');
			return;
		}

		const status = await env.DB.prepare(
			`SELECT id, account_id FROM statuses WHERE uri = ?1 AND deleted_at IS NULL LIMIT 1`,
		)
			.bind(obj.id)
			.first<{ id: string; account_id: string }>();

		if (!status) {
			console.log(`[update] Status not found: ${obj.id}`);
			return;
		}

		// Verify ownership
		if (status.account_id !== actorAccount.id) {
			console.warn('[update] Actor does not own the status being updated');
			return;
		}

		// Update the status content
		await env.DB.prepare(
			`UPDATE statuses SET content = ?1, content_warning = ?2, sensitive = ?3,
			 edited_at = ?4, updated_at = ?5 WHERE id = ?6`,
		)
			.bind(
				obj.content ?? '',
				obj.summary ?? '',
				obj.sensitive ? 1 : 0,
				now,
				now,
				status.id,
			)
			.run();

		// Notify local followers about the update
		const localFollowers = await env.DB.prepare(
			`SELECT f.account_id FROM follows f
			 JOIN accounts a ON a.id = f.account_id
			 WHERE f.target_account_id = ?1 AND a.domain IS NULL`,
		)
			.bind(actorAccount.id)
			.all<{ account_id: string }>();

		if (localFollowers.results) {
			for (const follower of localFollowers.results) {
				await env.QUEUE_INTERNAL.send({
					type: 'create_notification',
					recipientAccountId: follower.account_id,
					senderAccountId: actorAccount.id,
					notificationType: 'update',
					statusId: status.id,
				});
			}
		}
	}
}
