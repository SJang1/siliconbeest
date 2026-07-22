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
import {
	canAccountInteractWithStatus,
	canQuoteStatusById,
} from '../../services/permissions';
import {
	canReblogStatus,
	constrainQuoteVisibility,
	parseStatusVisibility,
	type StatusVisibility,
} from '../../../../../packages/shared/permissions';

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

function getAddressTargets(value: string | string[] | undefined): string[] {
	if (typeof value === 'string') return [value];
	if (!Array.isArray(value)) return [];
	return value.filter((target): target is string => typeof target === 'string');
}

function resolveVisibility(activity: APActivity): string | null {
	const to = getAddressTargets(activity.to);
	const cc = getAddressTargets(activity.cc);
	if (to.some(isPublicCollection)) return 'public';
	if (to.length > 0 && cc.some(isPublicCollection)) return 'unlisted';
	if (to.some((target) => target.endsWith('/followers'))) return 'private';
	if (to.length > 0) return 'direct';
	return null;
}

function isPublicCollection(value: string): boolean {
	return value === 'https://www.w3.org/ns/activitystreams#Public'
		|| value === 'as:Public'
		|| value === 'Public';
}

class AnnounceProcessor extends BaseProcessor {
	async process(activity: APActivity): Promise<boolean> {
		// Relay Announce handling
		const relay = await env.DB_META_C000.prepare(
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
			return false;
		}

		const statusUri = idsFrom(activity.object);
		if (!statusUri) {
			console.warn('[announce] activity.object has no resolvable URI');
			return false;
		}

		const originalStatus = await this.findStatusByUri(statusUri);
		if (!originalStatus) {
			console.log(`[announce] Original status not found: ${statusUri}`);
			return false;
		}

		const boosterAccountId = await this.resolveActor(activity.actor);
		if (!boosterAccountId) {
			console.error('[announce] Could not resolve remote actor');
			return false;
		}
		if (!await canAccountInteractWithStatus(originalStatus.id, boosterAccountId)) return false;

		const wrapperVisibility = parseStatusVisibility(resolveVisibility(activity));
		if (!wrapperVisibility) return false;

		if (hasQuoteCommentary(activity)) {
			if (!await canQuoteStatusById(originalStatus.id, boosterAccountId)) return false;
			const constrainedVisibility = constrainQuoteVisibility(
				wrapperVisibility,
				originalStatus.visibility,
			);
			if (!constrainedVisibility) return false;
			return this.processQuoteAnnounce(
				activity,
				originalStatus.id,
				originalStatus.account_id,
				boosterAccountId,
				constrainedVisibility,
			);
		}
		if (!canReblogStatus(originalStatus.visibility)) return false;

		// Check for duplicate reblog
		const existingReblog = await env.DB_META_C000.prepare(
			`SELECT id FROM statuses
			 WHERE reblog_of_id = ?1 AND account_id = ?2 AND deleted_at IS NULL
			 LIMIT 1`,
		)
			.bind(originalStatus.id, boosterAccountId)
			.first();

		if (existingReblog) return false;

		const reblogUri = activity.id ?? `${activity.actor}/statuses/${originalStatus.id}`;

		const reblog = await this.statusRepo.create({
			uri: reblogUri,
			account_id: boosterAccountId,
			reblog_of_id: originalStatus.id,
			visibility: wrapperVisibility,
			local: 0,
		});

		await this.statusRepo.incrementCount(originalStatus.id, 'reblogs_count');
		await this.notifyIfLocal('reblog', originalStatus.account_id, boosterAccountId, originalStatus.id);

		await env.QUEUE_INTERNAL.send({
			type: 'timeline_fanout',
			statusId: reblog.id,
			accountId: boosterAccountId,
		});
		return true;
	}

	private async processQuoteAnnounce(
		activity: APActivity,
		originalStatusId: string,
		originalAccountId: string,
		boosterAccountId: string,
		visibility: StatusVisibility,
	): Promise<boolean> {
		const existingQuote = await env.DB_META_C000.prepare(
			`SELECT id FROM statuses
			 WHERE uri = ?1 AND account_id = ?2 AND deleted_at IS NULL
			 LIMIT 1`,
		).bind(activity.id ?? '', boosterAccountId).first();
		if (existingQuote) return false;

		const quoteUri = activity.id ?? `${activity.actor}/quotes/${originalStatusId}`;
		const content = sanitizeHtml(activity.content ?? '');

		const quote = await this.statusRepo.create({
			uri: quoteUri,
			url: quoteUri,
			account_id: boosterAccountId,
			text: content.replace(/<[^>]+>/g, ''),
			content,
			visibility,
			local: 0,
			quote_id: originalStatusId,
			quote_approval_status: 'accepted',
		});

		await this.statusRepo.incrementCount(originalStatusId, 'reblogs_count');
		await this.notifyIfLocal('reblog', originalAccountId, boosterAccountId, originalStatusId);
		await env.QUEUE_INTERNAL.send({
			type: 'timeline_fanout',
			statusId: quote.id,
			accountId: boosterAccountId,
		});
		return true;
	}
}

export async function processAnnounce(
	activity: APActivity,
	localAccountId: string,
): Promise<boolean> {
	return new AnnounceProcessor(localAccountId).process(activity);
}
