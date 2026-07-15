/**
 * Inbox Processor: Undo
 *
 * Handles incoming Undo activities. Reverses a previous Follow, Like,
 * Announce, or Block by the same actor.
 */

import type { APActivity, APObject } from '../../types/activitypub';
import { BaseProcessor } from './BaseProcessor';
import { env } from 'cloudflare:workers';
import { broadcastReactionEvent } from '../../services/streaming';
import {
	canAccountInteractWithStatus,
	canAccountOriginateFederationActivity,
	canUndoIncomingAccountTarget,
} from '../../services/permissions';
import { areActivityPubUrisEquivalent } from '../../../../../packages/shared/permissions';

/**
 * Determine the type and target of the activity being undone.
 */
function parseUndoTarget(object: APActivity['object']): {
	type: string | null;
	objectUri: string | null;
	activityUri: string | null;
	embeddedActorUri: string | null;
} {
	if (!object) {
		return { type: null, objectUri: null, activityUri: null, embeddedActorUri: null };
	}

	if (typeof object === 'string') {
		return { type: null, objectUri: null, activityUri: object, embeddedActorUri: null };
	}

	const obj = object as APObject & {
		actor?: string | APObject;
		object?: string | APObject;
	};
	const innerObject = obj.object;

	return {
		type: obj.type ?? null,
		objectUri: typeof innerObject === 'string'
			? innerObject
			: (innerObject as APObject)?.id ?? null,
		activityUri: obj.id ?? null,
		embeddedActorUri: typeof obj.actor === 'string'
			? obj.actor
			: obj.actor?.id ?? null,
	};
}

interface StoredFollowUndoTarget {
	kind: 'follow' | 'follow_request';
	id: string;
	targetAccountId: string;
}

class UndoProcessor extends BaseProcessor {
	async process(activity: APActivity): Promise<boolean> {
		const { type, objectUri, activityUri, embeddedActorUri } = parseUndoTarget(activity.object);

		const actorAccount = await this.findAccountByUri(activity.actor);
		if (!actorAccount) {
			console.warn(`[undo] Actor not found: ${activity.actor}`);
			return false;
		}
		if (!await canAccountOriginateFederationActivity(actorAccount.id)) return false;

		switch (type) {
			case 'Follow':
				await this.undoFollow(
					actorAccount.id,
					activity.actor,
					embeddedActorUri,
					objectUri,
					activityUri,
				);
				return false;
			case 'Like': {
				const innerObj = activity.object as Record<string, unknown> | undefined;
				if (innerObj && (innerObj._misskey_reaction || innerObj.content)) {
					return this.undoEmojiReaction(
						actorAccount.id,
						objectUri,
						(innerObj._misskey_reaction ?? innerObj.content) as string,
					);
				} else {
					return this.undoLike(actorAccount.id, objectUri, activityUri);
				}
			}
			case 'Announce':
				return this.undoAnnounce(actorAccount.id, objectUri);
			case 'Block':
				await this.undoBlock(
					actorAccount.id,
					activity.actor,
					embeddedActorUri,
					objectUri,
					activityUri,
				);
				return false;
			default:
				if (activityUri) {
					await this.undoFollow(
						actorAccount.id,
						activity.actor,
						null,
						null,
						activityUri,
					);
				}
				console.log(`[undo] Unhandled undo type: ${type}`);
				return false;
		}
	}

	private async undoFollow(
		actorAccountId: string,
		outerActorUri: string,
		embeddedActorUri: string | null,
		targetUri: string | null,
		followUri: string | null,
	): Promise<void> {
		const embeddedTarget = targetUri
			? await this.findAccountByUri(targetUri)
			: null;
		if (targetUri && !embeddedTarget) return;

		let stored: StoredFollowUndoTarget | null = null;
		if (followUri) {
			const row = await env.DB.prepare(
				`SELECT 'follow' AS kind, id, target_account_id
				 FROM follows
				 WHERE uri = ?1 AND account_id = ?2
				 UNION ALL
				 SELECT 'follow_request' AS kind, id, target_account_id
				 FROM follow_requests
				 WHERE uri = ?1 AND account_id = ?2
				 LIMIT 1`,
			).bind(followUri, actorAccountId).first<{
				kind: 'follow' | 'follow_request';
				id: string;
				target_account_id: string;
			}>();
			stored = row ? {
				kind: row.kind,
				id: row.id,
				targetAccountId: row.target_account_id,
			} : null;
			// An explicit activity URI never falls back to another relationship.
			if (!stored) return;
		} else if (embeddedTarget) {
			const row = await env.DB.prepare(
				`SELECT 'follow' AS kind, id, target_account_id
				 FROM follows
				 WHERE account_id = ?1 AND target_account_id = ?2
				 UNION ALL
				 SELECT 'follow_request' AS kind, id, target_account_id
				 FROM follow_requests
				 WHERE account_id = ?1 AND target_account_id = ?2
				 LIMIT 1`,
			).bind(actorAccountId, embeddedTarget.id).first<{
				kind: 'follow' | 'follow_request';
				id: string;
				target_account_id: string;
			}>();
			stored = row ? {
				kind: row.kind,
				id: row.id,
				targetAccountId: row.target_account_id,
			} : null;
		}
		if (!stored) return;

		const storedTargetMatches = embeddedTarget === null
			|| embeddedTarget.id === stored.targetAccountId;
		const embeddedActorMatches = embeddedActorUri === null
			|| areActivityPubUrisEquivalent(embeddedActorUri, outerActorUri);
		if (!await canUndoIncomingAccountTarget(
			actorAccountId,
			stored.targetAccountId,
			this.recipientAccountId || null,
			embeddedActorMatches,
			storedTargetMatches,
		)) return;

		const deleted = stored.kind === 'follow'
			? await env.DB.prepare(
				'DELETE FROM follows WHERE id = ?1 AND account_id = ?2 AND target_account_id = ?3',
			).bind(stored.id, actorAccountId, stored.targetAccountId).run()
			: await env.DB.prepare(
				'DELETE FROM follow_requests WHERE id = ?1 AND account_id = ?2 AND target_account_id = ?3',
			).bind(stored.id, actorAccountId, stored.targetAccountId).run();
		if ((deleted.meta?.changes ?? 0) === 0 || stored.kind !== 'follow') return;

		await env.DB.batch([
			env.DB.prepare(
				'UPDATE accounts SET followers_count = MAX(0, followers_count - 1) WHERE id = ?1',
			).bind(stored.targetAccountId),
			env.DB.prepare(
				'UPDATE accounts SET following_count = MAX(0, following_count - 1) WHERE id = ?1',
			).bind(actorAccountId),
			env.DB.prepare(
				`DELETE FROM list_accounts
				 WHERE account_id = ?1
				   AND list_id IN (SELECT id FROM lists WHERE account_id = ?2)`,
			).bind(stored.targetAccountId, actorAccountId),
		]);
	}

	private async undoLike(
		actorAccountId: string,
		statusUri: string | null,
		likeUri: string | null,
	): Promise<boolean> {
		let statusId: string | null = null;
		let favouriteId: string | null = null;

		if (likeUri) {
			const fav = await env.DB.prepare(
				`SELECT id, status_id FROM favourites WHERE uri = ?1 AND account_id = ?2 LIMIT 1`,
			)
				.bind(likeUri, actorAccountId)
				.first<{ id: string; status_id: string }>();

			if (fav) {
				statusId = fav.status_id;
				favouriteId = fav.id;
			}
		}

		if (!statusId && statusUri) {
			const status = await this.statusRepo.findByUri(statusUri);
			if (status) {
				statusId = status.id;
			}
		}

		if (!statusId || !await canAccountInteractWithStatus(statusId, actorAccountId)) return false;

		const deleted = favouriteId
			? await env.DB.prepare(
				'DELETE FROM favourites WHERE id = ?1 AND account_id = ?2 AND status_id = ?3',
			).bind(favouriteId, actorAccountId, statusId).run()
			: await env.DB.prepare(
				'DELETE FROM favourites WHERE account_id = ?1 AND status_id = ?2',
			).bind(actorAccountId, statusId).run();
		if ((deleted.meta?.changes ?? 0) === 0) return false;

		await this.statusRepo.decrementCount(statusId, 'favourites_count');
		return true;
	}

	private async undoAnnounce(
		actorAccountId: string,
		originalStatusUri: string | null,
	): Promise<boolean> {
		if (!originalStatusUri) {
			console.warn('[undo] Cannot undo announce without original status URI');
			return false;
		}

		const originalStatus = await this.statusRepo.findByUri(originalStatusUri);
		if (!originalStatus) return false;
		if (!await canAccountInteractWithStatus(originalStatus.id, actorAccountId)) return false;

		// Find and soft-delete the reblog
		const reblog = await env.DB.prepare(
			`SELECT id FROM statuses
			 WHERE (reblog_of_id = ?1 OR quote_id = ?1)
			   AND account_id = ?2
			   AND deleted_at IS NULL
			 LIMIT 1`,
		)
			.bind(originalStatus.id, actorAccountId)
			.first<{ id: string }>();

		if (!reblog) return false;
		const now = new Date().toISOString();
		const deleted = await env.DB.prepare(
			`UPDATE statuses SET deleted_at = ?1, updated_at = ?1
			 WHERE id = ?2 AND account_id = ?3 AND deleted_at IS NULL`,
		).bind(now, reblog.id, actorAccountId).run();
		if ((deleted.meta?.changes ?? 0) === 0) return false;

		await this.statusRepo.decrementCount(originalStatus.id, 'reblogs_count');
		return true;
	}

	private async undoEmojiReaction(
		actorAccountId: string,
		statusUri: string | null,
		emoji: string,
	): Promise<boolean> {
		if (!statusUri) {
			console.warn('[undo] Cannot undo emoji reaction without status URI');
			return false;
		}

		const status = await this.statusRepo.findByUri(statusUri);
		if (!status) return false;
		if (!await canAccountInteractWithStatus(status.id, actorAccountId)) return false;

		const deleted = await env.DB.prepare(
			`DELETE FROM emoji_reactions WHERE account_id = ?1 AND status_id = ?2 AND emoji = ?3`,
		)
			.bind(actorAccountId, status.id, emoji)
			.run();
		if ((deleted.meta?.changes ?? 0) === 0) return false;

		// Live-update connected clients viewing this status
		await broadcastReactionEvent(status.id);
		return true;
	}

	private async undoBlock(
		actorAccountId: string,
		outerActorUri: string,
		embeddedActorUri: string | null,
		targetUri: string | null,
		blockUri: string | null,
	): Promise<void> {
		if (!targetUri) {
			console.warn('[undo] Cannot undo block without target URI');
			return;
		}

		const targetAccount = await this.findAccountByUri(targetUri);
		if (!targetAccount) return;

		const storedBlock = await env.DB.prepare(
			`SELECT id, uri FROM blocks
			 WHERE account_id = ?1 AND target_account_id = ?2
			 LIMIT 1`,
		).bind(actorAccountId, targetAccount.id).first<{
			id: string;
			uri: string | null;
		}>();
		if (!storedBlock) return;

		const embeddedActorMatches = embeddedActorUri === null
			|| areActivityPubUrisEquivalent(embeddedActorUri, outerActorUri);
		const storedTargetMatches = blockUri === null || storedBlock.uri === blockUri;
		if (!await canUndoIncomingAccountTarget(
			actorAccountId,
			targetAccount.id,
			this.recipientAccountId || null,
			embeddedActorMatches,
			storedTargetMatches,
		)) return;

		await env.DB.prepare(
			`DELETE FROM blocks
			 WHERE id = ?1 AND account_id = ?2 AND target_account_id = ?3`,
		).bind(storedBlock.id, actorAccountId, targetAccount.id).run();
	}
}

export async function processUndo(
	activity: APActivity,
	localAccountId: string,
): Promise<boolean> {
	return new UndoProcessor(localAccountId).process(activity);
}
