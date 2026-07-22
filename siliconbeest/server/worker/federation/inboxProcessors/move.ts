/**
 * Inbox Processor: Move
 *
 * Handles incoming Move activities. Records that the old account has
 * moved to a new account by setting moved_to_account_id. Creates
 * notifications for local followers and enqueues re-follow activities.
 */

import type { APActivity } from '../../types/activitypub';
import { buildFollowActivity } from '../helpers/build-activity';
import { createFed } from '../fedify';
import { getFedifyContext } from '../helpers/send';
import { isActor } from '@fedify/fedify/vocab';
import { generateUlid } from '../../utils/ulid';
import { BaseProcessor } from './BaseProcessor';
import { env } from 'cloudflare:workers';
import {
	areActivityPubUrisEquivalent,
} from '../../../../../packages/shared/permissions';
import {
	canProcessIncomingMove,
	getFederatedMoveRefollowCandidates,
} from '../../services/permissions';

class MoveProcessor extends BaseProcessor {
	async process(activity: APActivity): Promise<void> {
		const rawOldUri =
			typeof activity.object === 'string' ? activity.object : undefined;
		const rawNewUri =
			typeof activity.target === 'string' ? activity.target : undefined;

		if (!rawOldUri || !rawNewUri) {
			console.warn('[move] Missing object or target URI');
			return;
		}

		if (!areActivityPubUrisEquivalent(activity.actor, rawOldUri)) {
			console.warn('[move] Actor does not match old account URI');
			return;
		}

		const normalizedOldUri = new URL(rawOldUri).href;
		const oldAccount =
			(await this.findAccountByUri(normalizedOldUri))
			?? (normalizedOldUri !== rawOldUri
				? await this.findAccountByUri(rawOldUri)
				: null);
		if (!oldAccount) {
			console.warn(`[move] Old account not found: ${normalizedOldUri}`);
			return;
		}

		// Fetch and verify the target document before trusting its alias claim.
		const fed = createFed();
		const ctx = getFedifyContext(fed);
		const localAcct = await env.DB_META_C000.prepare(
			`SELECT a.username
			 FROM accounts a
			 JOIN users u ON u.account_id = a.id
			 WHERE a.domain IS NULL
			   AND a.suspended_at IS NULL
			   AND COALESCE(a.memorial, 0) = 0
			   AND u.disabled = 0
			   AND u.approved = 1
			 ORDER BY CASE WHEN a.id = ?1 THEN 0 ELSE 1 END, a.created_at ASC
			 LIMIT 1`,
		).bind(this.recipientAccountId || null).first<{ username: string }>();
		if (!localAcct) return;
		const docLoader = await ctx.getDocumentLoader({ identifier: localAcct.username });
		const newActorObj = await ctx.lookupObject(rawNewUri, { documentLoader: docLoader });
		if (!newActorObj || !isActor(newActorObj) || !newActorObj.id) {
			console.warn(`[move] Could not fetch new account actor document: ${rawNewUri}`);
			return;
		}
		const canonicalNewUri = newActorObj.id.href;
		if (!areActivityPubUrisEquivalent(rawNewUri, canonicalNewUri)) {
			console.warn('[move] Target actor document identity does not match target URI');
			return;
		}

		const alsoKnownAs: string[] = newActorObj.aliasIds
			? Array.from(newActorObj.aliasIds).map((u: URL) => u.href)
			: [];
		const aliasesOld = alsoKnownAs.some((alias) =>
			areActivityPubUrisEquivalent(alias, oldAccount.uri));
		if (!aliasesOld) {
			console.warn(`[move] Rejecting Move: new account ${canonicalNewUri} does not list ${oldAccount.uri} in alsoKnownAs`);
			return;
		}

		const existingNewAccount = await this.findAccountByUri(canonicalNewUri);
		const newAccountId = existingNewAccount?.id
			?? await this.resolveActor(canonicalNewUri);
		if (!newAccountId) {
			console.error('[move] Could not resolve new account');
			return;
		}

		const recipientAccountId = this.recipientAccountId || null;
		if (!await canProcessIncomingMove(
			oldAccount.id,
			oldAccount.id,
			newAccountId,
			recipientAccountId,
			aliasesOld,
		)) {
			console.warn('[move] Move permission denied');
			return;
		}

		let newlyRecorded = oldAccount.moved_to_account_id === null;
		if (newlyRecorded) {
			const now = new Date().toISOString();
			const recorded = await env.DB_META_C000.prepare(
				`UPDATE accounts
				 SET moved_to_account_id = ?1, moved_at = ?2, updated_at = ?2
				 WHERE id = ?3 AND moved_to_account_id IS NULL`,
			).bind(newAccountId, now, oldAccount.id).run();
			if ((recorded.meta?.changes ?? 0) === 0) {
				const raced = await this.accountRepo.findById(oldAccount.id);
				if (raced?.moved_to_account_id !== newAccountId) return;
				newlyRecorded = false;
			}
		}

		const [newActorAccount, followers] = await Promise.all([
			this.accountRepo.findById(newAccountId),
			getFederatedMoveRefollowCandidates(oldAccount.id, newAccountId),
		]);
		if (!newActorAccount) return;

		let refollowed = 0;
		for (const follower of followers) {
			if (newlyRecorded) {
				try {
					await env.QUEUE_INTERNAL.send({
						type: 'create_notification',
						recipientAccountId: follower.accountId,
						senderAccountId: oldAccount.id,
						notificationType: 'move',
					});
				} catch (error) {
					console.error('[move] Failed to enqueue move notification:', error);
				}
			}

			if (newActorAccount.domain === null) {
				const now = new Date().toISOString();
				const inserted = await env.DB_META_C000.prepare(
					`INSERT OR IGNORE INTO follows
					   (id, account_id, target_account_id, uri, created_at, updated_at)
					 VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
				).bind(
					generateUlid(),
					follower.accountId,
					newAccountId,
					`https://${env.INSTANCE_DOMAIN}/activities/${generateUlid()}`,
					now,
				).run();
				if ((inserted.meta?.changes ?? 0) === 0) continue;
				await env.DB_META_C000.batch([
					env.DB_META_C000.prepare(
						'UPDATE accounts SET following_count = following_count + 1 WHERE id = ?1',
					).bind(follower.accountId),
					env.DB_META_C000.prepare(
						'UPDATE accounts SET followers_count = followers_count + 1 WHERE id = ?1',
					).bind(newAccountId),
				]);
				refollowed += 1;
				continue;
			}

			const newInbox = newActorAccount.inbox_url
				|| newActorAccount.shared_inbox_url
				|| `https://${newActorAccount.domain}/inbox`;
			const followJson = await buildFollowActivity(follower.uri, newActorAccount.uri);
			const followActivity = JSON.parse(followJson) as APActivity;
			if (!followActivity.id) continue;
			const requestId = generateUlid();
			const now = new Date().toISOString();
			const inserted = await env.DB_META_C000.prepare(
				`INSERT OR IGNORE INTO follow_requests
				   (id, account_id, target_account_id, uri, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
			).bind(
				requestId,
				follower.accountId,
				newAccountId,
				followActivity.id,
				now,
			).run();
			if ((inserted.meta?.changes ?? 0) === 0) continue;

			try {
				await env.QUEUE_FEDERATION.send({
					type: 'deliver_activity',
					activity: followActivity,
					inboxUrl: newInbox,
					actorAccountId: follower.accountId,
				});
				refollowed += 1;
			} catch (error) {
				await env.DB_META_C000.prepare(
					'DELETE FROM follow_requests WHERE id = ?1 AND account_id = ?2 AND target_account_id = ?3',
				).bind(requestId, follower.accountId, newAccountId).run();
				console.error('[move] Failed to enqueue re-follow:', error);
			}
		}

		console.log(
			`[move] Recorded move and prepared ${refollowed} re-follows: ${oldAccount.uri} -> ${canonicalNewUri}`,
		);
	}
}

export async function processMove(
	activity: APActivity,
	localAccountId: string,
): Promise<void> {
	await new MoveProcessor(localAccountId).process(activity);
}
