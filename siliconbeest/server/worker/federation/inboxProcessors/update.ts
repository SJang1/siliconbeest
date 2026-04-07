/**
 * Inbox Processor: Update
 *
 * Handles incoming Update activities. If the object is a Person/Actor,
 * updates the cached account profile. If the object is a Note, updates
 * the cached status content and creates an 'update' notification for
 * local users who interacted with the post.
 */

import type { APActivity, APObject, APActor, APQuestion, APQuestionOption } from '../../types/activitypub';
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

		// Handle Note or Question update
		if (obj.type === 'Note' || obj.type === 'Question') {
			if (!obj.id) {
				console.warn(`[update] ${obj.type} has no id`);
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

			// Update poll data if this is a Question
			if (obj.type === 'Question') {
				const question = obj as APQuestion;
				const poll = await env.DB.prepare(
					'SELECT id FROM polls WHERE status_id = ?1 LIMIT 1',
				).bind(status.id).first<{ id: string }>();

				if (poll) {
					const optionsRaw = question.oneOf ?? question.anyOf;
					if (optionsRaw && optionsRaw.length > 0) {
						const options = optionsRaw
							.filter((o: APQuestionOption) => o.name)
							.map((o: APQuestionOption) => ({
								title: o.name,
								votes_count: o.replies?.totalItems ?? 0,
							}));
						const votesCount = options.reduce((sum: number, o: { votes_count: number }) => sum + o.votes_count, 0);
						const votersCount = question.votersCount ?? 0;

						const updates: string[] = [];
						const values: unknown[] = [];
						let idx = 1;

						updates.push(`options = ?${idx}`); values.push(JSON.stringify(options)); idx++;
						updates.push(`votes_count = ?${idx}`); values.push(votesCount); idx++;
						updates.push(`voters_count = ?${idx}`); values.push(votersCount); idx++;

						// Handle closed status
						if (question.closed) {
							const closedAt = typeof question.closed === 'string'
								? new Date(question.closed).toISOString()
								: new Date().toISOString();
							updates.push(`expires_at = ?${idx}`); values.push(closedAt); idx++;
						} else if (question.endTime) {
							updates.push(`expires_at = ?${idx}`); values.push(new Date(question.endTime).toISOString()); idx++;
						}

						values.push(poll.id);
						await env.DB.prepare(
							`UPDATE polls SET ${updates.join(', ')} WHERE id = ?${idx}`,
						).bind(...values).run();
					}
				}
			}

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
