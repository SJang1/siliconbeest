/**
 * Inbox Processor: Undo
 *
 * Handles incoming Undo activities. Reverses a previous Follow, Like,
 * Announce, or Block by the same actor.
 */

import type { APActivity, APObject } from '../../types/activitypub';
import { BaseProcessor } from './BaseProcessor';
import { env } from 'cloudflare:workers';

/**
 * Determine the type and target of the activity being undone.
 */
function parseUndoTarget(object: APActivity['object']): {
	type: string | null;
	objectUri: string | null;
	activityUri: string | null;
} {
	if (!object) return { type: null, objectUri: null, activityUri: null };

	if (typeof object === 'string') {
		return { type: null, objectUri: null, activityUri: object };
	}

	const obj = object as APObject & { actor?: string; object?: string | APObject };
	const innerObject = obj.object;

	return {
		type: obj.type ?? null,
		objectUri: typeof innerObject === 'string'
			? innerObject
			: (innerObject as APObject)?.id ?? null,
		activityUri: obj.id ?? null,
	};
}

class UndoProcessor extends BaseProcessor {
	async process(activity: APActivity): Promise<void> {
		const { type, objectUri, activityUri } = parseUndoTarget(activity.object);

		const actorAccount = await this.findAccountByUri(activity.actor);
		if (!actorAccount) {
			console.warn(`[undo] Actor not found: ${activity.actor}`);
			return;
		}

		switch (type) {
			case 'Follow':
				await this.undoFollow(actorAccount.id, objectUri, activityUri);
				break;
			case 'Like': {
				const innerObj = activity.object as unknown as Record<string, unknown> | undefined;
				if (innerObj && (innerObj._misskey_reaction || innerObj.content)) {
					await this.undoEmojiReaction(
						actorAccount.id,
						objectUri,
						(innerObj._misskey_reaction ?? innerObj.content) as string,
					);
				} else {
					await this.undoLike(actorAccount.id, objectUri, activityUri);
				}
				break;
			}
			case 'Announce':
				await this.undoAnnounce(actorAccount.id, objectUri);
				break;
			case 'Block':
				await this.undoBlock(actorAccount.id, objectUri);
				break;
			default:
				if (activityUri) {
					const followResult = await env.DB.prepare(
						`DELETE FROM follows WHERE uri = ?1 AND account_id = ?2`,
					)
						.bind(activityUri, actorAccount.id)
						.run();
					if ((followResult.meta?.changes ?? 0) > 0) return;
					await env.DB.prepare(
						`DELETE FROM follow_requests WHERE uri = ?1 AND account_id = ?2`,
					)
						.bind(activityUri, actorAccount.id)
						.run();
				}
				console.log(`[undo] Unhandled undo type: ${type}`);
				break;
		}
	}

	private async undoFollow(
		actorAccountId: string,
		targetUri: string | null,
		followUri: string | null,
	): Promise<void> {
		let targetAccountId: string | null = null;

		if (targetUri) {
			const target = await this.findAccountByUri(targetUri);
			targetAccountId = target?.id ?? null;
		}

		let deleted = false;

		if (followUri) {
			const result = await env.DB.prepare(
				`DELETE FROM follows WHERE uri = ?1 AND account_id = ?2`,
			)
				.bind(followUri, actorAccountId)
				.run();
			deleted = (result.meta?.changes ?? 0) > 0;
		}

		if (!deleted && targetAccountId) {
			const result = await env.DB.prepare(
				`DELETE FROM follows WHERE account_id = ?1 AND target_account_id = ?2`,
			)
				.bind(actorAccountId, targetAccountId)
				.run();
			deleted = (result.meta?.changes ?? 0) > 0;
		}

		if (deleted && targetAccountId) {
			await this.accountRepo.decrementCount(targetAccountId, 'followers_count');
			await this.accountRepo.decrementCount(actorAccountId, 'following_count');
		}

		if (targetAccountId) {
			await env.DB.prepare(
				`DELETE FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2`,
			)
				.bind(actorAccountId, targetAccountId)
				.run();
		}
	}

	private async undoLike(
		actorAccountId: string,
		statusUri: string | null,
		likeUri: string | null,
	): Promise<void> {
		let statusId: string | null = null;

		if (likeUri) {
			const fav = await env.DB.prepare(
				`SELECT id, status_id FROM favourites WHERE uri = ?1 AND account_id = ?2 LIMIT 1`,
			)
				.bind(likeUri, actorAccountId)
				.first<{ id: string; status_id: string }>();

			if (fav) {
				statusId = fav.status_id;
				await this.favouriteRepo.delete(fav.id);
			}
		}

		if (!statusId && statusUri) {
			const status = await this.statusRepo.findByUri(statusUri);
			if (status) {
				statusId = status.id;
				await this.favouriteRepo.deleteByAccountAndStatus(actorAccountId, statusId);
			}
		}

		if (statusId) {
			await this.statusRepo.decrementCount(statusId, 'favourites_count');
		}
	}

	private async undoAnnounce(
		actorAccountId: string,
		originalStatusUri: string | null,
	): Promise<void> {
		if (!originalStatusUri) {
			console.warn('[undo] Cannot undo announce without original status URI');
			return;
		}

		const originalStatus = await this.statusRepo.findByUri(originalStatusUri);
		if (!originalStatus) return;

		// Find and soft-delete the reblog
		const reblog = await env.DB.prepare(
			`SELECT id FROM statuses
			 WHERE reblog_of_id = ?1 AND account_id = ?2 AND deleted_at IS NULL
			 LIMIT 1`,
		)
			.bind(originalStatus.id, actorAccountId)
			.first<{ id: string }>();

		if (reblog) {
			await this.statusRepo.delete(reblog.id);

			await env.DB.prepare(
				`DELETE FROM home_timeline_entries WHERE status_id = ?1`,
			)
				.bind(reblog.id)
				.run();
		}

		await this.statusRepo.decrementCount(originalStatus.id, 'reblogs_count');
	}

	private async undoEmojiReaction(
		actorAccountId: string,
		statusUri: string | null,
		emoji: string,
	): Promise<void> {
		if (!statusUri) {
			console.warn('[undo] Cannot undo emoji reaction without status URI');
			return;
		}

		const status = await this.statusRepo.findByUri(statusUri);
		if (!status) return;

		await env.DB.prepare(
			`DELETE FROM emoji_reactions WHERE account_id = ?1 AND status_id = ?2 AND emoji = ?3`,
		)
			.bind(actorAccountId, status.id, emoji)
			.run();
	}

	private async undoBlock(
		actorAccountId: string,
		targetUri: string | null,
	): Promise<void> {
		if (!targetUri) {
			console.warn('[undo] Cannot undo block without target URI');
			return;
		}

		const targetAccount = await this.findAccountByUri(targetUri);
		if (!targetAccount) return;

		await env.DB.prepare(
			`DELETE FROM blocks WHERE account_id = ?1 AND target_account_id = ?2`,
		)
			.bind(actorAccountId, targetAccount.id)
			.run();
	}
}

export async function processUndo(
	activity: APActivity,
	_localAccountId: string,
): Promise<void> {
	await new UndoProcessor().process(activity);
}
