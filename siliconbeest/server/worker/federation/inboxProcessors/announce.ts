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
import { sanitizeHtml } from '../../utils/sanitize';

function idsFrom(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) {
		for (const item of value) {
			const id = idsFrom(item);
			if (id) return id;
		}
		return undefined;
	}
	if (value && typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		return idsFrom(obj.id) ?? idsFrom(obj.href);
	}
	return undefined;
}

function hasQuoteCommentary(activity: APActivity): boolean {
	return typeof activity.content === 'string' && activity.content.trim().length > 0
		|| activity.attachment !== undefined
		|| activity.inReplyTo !== undefined;
}

function resolveVisibility(activity: APActivity): string {
	const to = Array.isArray(activity.to) ? activity.to : activity.to ? [activity.to] : [];
	const cc = Array.isArray(activity.cc) ? activity.cc : activity.cc ? [activity.cc] : [];
	if (to.some(isPublicCollection)) return 'public';
	if (cc.some(isPublicCollection)) return 'unlisted';
	if (to.some((target) => target.endsWith('/followers'))) return 'private';
	return 'direct';
}

function isPublicCollection(value: string): boolean {
	return value === 'https://www.w3.org/ns/activitystreams#Public'
		|| value === 'as:Public'
		|| value === 'Public';
}

class AnnounceProcessor extends BaseProcessor {
	async process(activity: APActivity): Promise<void> {
		// Relay Announce handling
		const relay = await env.DB.prepare(
			"SELECT id FROM relays WHERE actor_uri = ?1 AND state = 'accepted'",
		)
			.bind(String(activity.actor))
			.first();

		if (relay) {
			const objectUri = idsFrom(activity.object);
			if (objectUri) {
				await env.QUEUE_FEDERATION.send({
					type: 'fetch_remote_status',
					statusUri: objectUri,
					...(this.recipientAccountId ? { signerAccountId: this.recipientAccountId } : {}),
				});
			}
			return;
		}

		const statusUri = idsFrom(activity.object);
		if (!statusUri) {
			console.warn('[announce] activity.object has no resolvable URI');
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

		if (hasQuoteCommentary(activity)) {
			await this.processQuoteAnnounce(activity, originalStatus.id, originalStatus.account_id, boosterAccountId);
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

	private async processQuoteAnnounce(
		activity: APActivity,
		originalStatusId: string,
		originalAccountId: string,
		boosterAccountId: string,
	): Promise<void> {
		const existingQuote = await env.DB.prepare(
			`SELECT id FROM statuses
			 WHERE uri = ?1 AND account_id = ?2 AND deleted_at IS NULL
			 LIMIT 1`,
		).bind(activity.id ?? '', boosterAccountId).first();
		if (existingQuote) return;

		const quoteUri = activity.id ?? `${activity.actor}/quotes/${originalStatusId}`;
		const content = sanitizeHtml(activity.content ?? '');

		const quote = await this.statusRepo.create({
			uri: quoteUri,
			url: quoteUri,
			account_id: boosterAccountId,
			text: content.replace(/<[^>]+>/g, ''),
			content,
			visibility: resolveVisibility(activity),
			local: 0,
			quote_id: originalStatusId,
			quote_approval_status: 'none',
		});

		await this.statusRepo.incrementCount(originalStatusId, 'reblogs_count');
		await this.notifyIfLocal('reblog', originalAccountId, boosterAccountId, originalStatusId);
		await env.QUEUE_INTERNAL.send({
			type: 'timeline_fanout',
			statusId: quote.id,
			accountId: boosterAccountId,
		});
	}
}

export async function processAnnounce(
	activity: APActivity,
	localAccountId: string,
): Promise<void> {
	await new AnnounceProcessor(localAccountId).process(activity);
}
