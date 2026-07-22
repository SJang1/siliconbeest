/**
 * Inbox Processor: Reject(Follow)
 *
 * Handles incoming Reject activities. Removes the pending follow_request
 * that corresponds to a Follow we sent.
 */

import type { APActivity, APObject } from '../../types/activitypub';
import { BaseProcessor } from './BaseProcessor';
import { env } from 'cloudflare:workers';
import { FEP044F_QUOTE_REQUEST, getId } from '../helpers/quote';
import {
	canApplyFederatedResponse,
	canApplyQuoteResponse,
} from '../../../../../packages/shared/permissions';
import { canAccountOriginateFederationActivity } from '../../services/permissions';

class RejectProcessor extends BaseProcessor {
	async process(activity: APActivity): Promise<void> {
		const object = activity.object;
		if (!object) {
			console.warn('[reject] activity.object is missing');
			return;
		}

		if (typeof object === 'object') {
			const objectType = (object as APObject).type;
			if (objectType === 'QuoteRequest' || objectType === FEP044F_QUOTE_REQUEST) {
				await this.processQuoteReject(activity, object as APObject);
				return;
			}
		}

		const remoteAccount = await this.findAccountByUri(activity.actor);
		if (!remoteAccount) {
			console.warn(`[reject] Remote actor not found: ${activity.actor}`);
			return;
		}
		if (!await canAccountOriginateFederationActivity(remoteAccount.id)) return;

		type FollowRequestResponseTarget = {
			id: string;
			account_id: string;
			target_account_id: string;
			local_initiator_uri: string;
			response_owner_uri: string;
		};
		const followObject = typeof object === 'object' ? object as APObject : null;
		const objectId = typeof object === 'string' ? object : followObject?.id ?? null;
		let followRequest: FollowRequestResponseTarget | null = null;
		if (objectId) {
			followRequest = await env.DB_META_C000.prepare(
				`SELECT fr.id, fr.account_id, fr.target_account_id,
				        local_initiator.uri AS local_initiator_uri,
				        response_owner.uri AS response_owner_uri
				 FROM follow_requests fr
				 JOIN accounts local_initiator ON local_initiator.id = fr.account_id
				 JOIN accounts response_owner ON response_owner.id = fr.target_account_id
				 WHERE fr.uri = ?1
				   AND fr.target_account_id = ?2
				   AND local_initiator.domain IS NULL
				 LIMIT 1`,
			).bind(objectId, remoteAccount.id).first<FollowRequestResponseTarget>();
		}
		if (!followRequest && followObject && !followObject.id) {
			followRequest = await env.DB_META_C000.prepare(
				`SELECT fr.id, fr.account_id, fr.target_account_id,
				        local_initiator.uri AS local_initiator_uri,
				        response_owner.uri AS response_owner_uri
				 FROM follow_requests fr
				 JOIN accounts local_initiator ON local_initiator.id = fr.account_id
				 JOIN accounts response_owner ON response_owner.id = fr.target_account_id
				 WHERE fr.target_account_id = ?1
				   AND local_initiator.domain IS NULL
				 LIMIT 1`,
			).bind(remoteAccount.id).first<FollowRequestResponseTarget>();
		}
		if (!followRequest) return;

		const embeddedInitiatorUri = followObject ? getId(followObject.actor) : null;
		const embeddedOwnerUri = followObject ? getId(followObject.object) : null;
		if (!canApplyFederatedResponse({
			actorAccountId: remoteAccount.id,
			ownerAccountId: followRequest.target_account_id,
			localInitiatorAccountId: followRequest.account_id,
			recipientAccountId: this.recipientAccountId || null,
			localInitiatorIsLocal: true,
			requestPending: true,
			embeddedInitiatorMatches: !embeddedInitiatorUri
				|| embeddedInitiatorUri === followRequest.local_initiator_uri,
			embeddedOwnerMatches: !embeddedOwnerUri
				|| embeddedOwnerUri === followRequest.response_owner_uri,
		}) || !await canAccountOriginateFederationActivity(followRequest.account_id)) {
			return;
		}

		const deleted = await env.DB_META_C000.prepare(
			`DELETE FROM follow_requests
			 WHERE id = ?1 AND account_id = ?2 AND target_account_id = ?3`,
		).bind(
			followRequest.id,
			followRequest.account_id,
			followRequest.target_account_id,
		).run();
		if ((deleted.meta?.changes ?? 0) !== 1) {
			console.warn('[reject] Pending follow request changed before rejection');
		}
	}

	private async processQuoteReject(activity: APActivity, quoteRequest: APObject): Promise<void> {
		const instrumentUri = getId(quoteRequest.instrument);
		const quotedUri = getId(quoteRequest.object);
		if (!instrumentUri || !quotedUri) {
			console.warn('[reject] QuoteRequest Reject missing instrument or object');
			return;
		}

		const responseActorAccountId = await this.resolveActor(activity.actor);
		if (!responseActorAccountId
			|| !await canAccountOriginateFederationActivity(responseActorAccountId)) {
			return;
		}

		const status = await env.DB_META_C000.prepare(
			`SELECT s.id, s.account_id AS local_quote_author_account_id,
			        s.quote_approval_status,
			        qs.account_id AS quote_target_author_account_id
			 FROM statuses s
			 JOIN statuses qs ON qs.id = s.quote_id
			 WHERE s.uri = ?1
			   AND s.local = 1
			   AND s.deleted_at IS NULL
			   AND qs.uri = ?2
			 LIMIT 1`,
		).bind(instrumentUri, quotedUri).first<{
			id: string;
			local_quote_author_account_id: string;
			quote_approval_status: string | null;
			quote_target_author_account_id: string;
		}>();
		if (!status || !canApplyQuoteResponse({
			actorAccountId: responseActorAccountId,
			ownerAccountId: status.quote_target_author_account_id,
			localQuoteAuthorAccountId: status.local_quote_author_account_id,
			recipientAccountId: this.recipientAccountId || null,
			quoteApprovalStatus: status.quote_approval_status,
		})) {
			return;
		}

		await env.DB_META_C000.prepare(
			`UPDATE statuses
			 SET quote_id = NULL,
			     quote_authorization_uri = NULL,
			     quote_approval_status = 'rejected',
			     updated_at = ?1
			 WHERE id = ?2 AND quote_approval_status = 'pending'`,
		).bind(new Date().toISOString(), status.id).run();
	}
}

export async function processReject(
	activity: APActivity,
	localAccountId: string,
): Promise<void> {
	await new RejectProcessor(localAccountId).process(activity);
}
