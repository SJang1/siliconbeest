/**
 * Inbox Processor: Delete
 *
 * Handles incoming Delete activities. If the object is a status URI
 * (or Tombstone), soft-deletes the status. If the actor URI matches
 * the object, treats it as an actor deletion (account suspension).
 */

import type { APActivity, APObject } from '../../types/activitypub';
import { BaseProcessor } from './BaseProcessor';
import { env } from 'cloudflare:workers';
import { canProcessIncomingOwnedDelete } from '../../services/permissions';
import { areActivityPubUrisEquivalent } from '../../../../../packages/shared/permissions';

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

		const revokedAuthorization = await env.DB.prepare(
			`SELECT qa.id, qa.attributed_to_account_id, a.uri AS attributed_to_uri
			 FROM quote_authorizations qa
			 JOIN accounts a ON a.id = qa.attributed_to_account_id
			 WHERE qa.uri = ?1 AND qa.revoked_at IS NULL
			 LIMIT 1`,
		).bind(objectUri).first<{ id: string; attributed_to_account_id: string; attributed_to_uri: string }>();

		const actorAccount = await this.findAccountByUri(activity.actor);
		if (!actorAccount) {
			console.warn(`[delete] Actor not found: ${activity.actor}`);
			return;
		}

		if (revokedAuthorization) {
			if (!await canProcessIncomingOwnedDelete(
				actorAccount.id,
				revokedAuthorization.attributed_to_account_id,
			)) {
				console.warn('[delete] Actor does not own the quote authorization being deleted');
				return;
			}

			await env.DB.batch([
				env.DB.prepare(
					'UPDATE quote_authorizations SET revoked_at = ?1, updated_at = ?1 WHERE id = ?2',
				).bind(now, revokedAuthorization.id),
				env.DB.prepare(
					`UPDATE statuses
					 SET quote_id = NULL,
					     quote_authorization_uri = NULL,
					     quote_approval_status = 'revoked',
					     updated_at = ?1
					 WHERE quote_authorization_uri = ?2`,
				).bind(now, objectUri),
			]);
			return;
		}

		const revokedRemoteAuthorization = await env.DB.prepare(
			`SELECT s.id, qs.account_id AS authorization_owner_account_id
			 FROM statuses s
			 JOIN statuses qs ON qs.id = s.quote_id
			 WHERE s.quote_authorization_uri = ?1 AND s.deleted_at IS NULL
			 LIMIT 1`,
		).bind(objectUri).first<{
			id: string;
			authorization_owner_account_id: string;
		}>();
		if (revokedRemoteAuthorization) {
			if (!await canProcessIncomingOwnedDelete(
				actorAccount.id,
				revokedRemoteAuthorization.authorization_owner_account_id,
			)) {
				console.warn('[delete] Actor does not own the remote quote authorization being deleted');
				return;
			}
			await env.DB.prepare(
				`UPDATE statuses
				 SET quote_id = NULL,
				     quote_authorization_uri = NULL,
				     quote_approval_status = 'revoked',
				     updated_at = ?1
				 WHERE quote_authorization_uri = ?2
				   AND quote_id IN (SELECT id FROM statuses WHERE account_id = ?3)`,
			).bind(now, objectUri, actorAccount.id).run();
			return;
		}

		// Check if this is an actor self-deletion (actor URI == object URI)
		if (areActivityPubUrisEquivalent(objectUri, actorAccount.uri)) {
			if (!await canProcessIncomingOwnedDelete(actorAccount.id, actorAccount.id)) {
				return;
			}
			// Suspend the account
			await this.accountRepo.update(actorAccount.id, { suspended_at: now });

			// Soft-delete all their statuses
			await this.statusRepo.softDeleteByAccount(actorAccount.id);

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
		if (!await canProcessIncomingOwnedDelete(actorAccount.id, status.account_id)) {
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

	}
}

export async function processDelete(
	activity: APActivity,
	localAccountId: string,
): Promise<void> {
	await new DeleteProcessor(localAccountId).process(activity);
}
