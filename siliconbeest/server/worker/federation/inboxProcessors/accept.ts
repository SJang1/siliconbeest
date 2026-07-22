/**
 * Inbox Processor: Accept(Follow)
 *
 * Handles incoming Accept activities, confirming that a remote actor
 * has accepted our outgoing follow request. Moves the pending request
 * from follow_requests to follows and updates counts.
 */
import { env } from 'cloudflare:workers';
import type { APActivity, APObject } from '../../types/activitypub';
import { generateUlid } from '../../utils/ulid';
import { BaseProcessor } from './BaseProcessor';
import { AS_PUBLIC, FEP044F_QUOTE_REQUEST, addQuoteProperties, getId, quoteContext } from '../helpers/quote';
import {
	canApplyFederatedResponse,
	canApplyQuoteResponse,
} from '../../../../../packages/shared/permissions';
import { canAccountOriginateFederationActivity } from '../../services/permissions';

class AcceptProcessor extends BaseProcessor {
	async process(activity: APActivity): Promise<void> {
		const object = activity.object;
		if (!object) {
			console.warn('[accept] activity.object is missing');
			return;
		}

		if (typeof object === 'object') {
			const objectType = (object as APObject).type;
			if (objectType === 'QuoteRequest' || objectType === FEP044F_QUOTE_REQUEST) {
				await this.processQuoteAccept(activity, object as APObject);
				return;
			}
		}

		// Relay Accept handling
		const followId = typeof object === 'string' ? object : (object as APObject).id;
		if (followId) {
			const relay = await env.DB_META_C000.prepare(
				'SELECT id FROM relays WHERE follow_activity_id = ?1',
			)
				.bind(followId)
				.first<{ id: string }>();

			if (relay) {
				await env.DB_META_C000.prepare(
					"UPDATE relays SET state = 'accepted', actor_uri = ?1, updated_at = ?2 WHERE id = ?3",
				)
					.bind(String(activity.actor), new Date().toISOString(), relay.id)
					.run();
				return;
			}
		}

		const remoteAccount = await this.findAccountByUri(activity.actor);
		if (!remoteAccount) {
			console.warn(`[accept] Remote actor not found: ${activity.actor}`);
			return;
		}
		if (!await canAccountOriginateFederationActivity(remoteAccount.id)) return;

		// Try to find the pending follow_request
		type FollowRequestResponseTarget = {
			id: string;
			account_id: string;
			target_account_id: string;
			uri: string | null;
			local_initiator_uri: string;
			response_owner_uri: string;
		};
		let followRequest: FollowRequestResponseTarget | null = null;
		const followObject = typeof object === 'object' ? object as APObject : null;
		const objectId = typeof object === 'string' ? object : followObject?.id ?? null;

		if (objectId) {
			followRequest = await env.DB_META_C000.prepare(
				`SELECT fr.id, fr.account_id, fr.target_account_id, fr.uri,
				        local_initiator.uri AS local_initiator_uri,
				        response_owner.uri AS response_owner_uri
				 FROM follow_requests fr
				 JOIN accounts local_initiator ON local_initiator.id = fr.account_id
				 JOIN accounts response_owner ON response_owner.id = fr.target_account_id
				 WHERE fr.uri = ?1
				   AND fr.target_account_id = ?2
				   AND local_initiator.domain IS NULL
				 LIMIT 1`,
			)
				.bind(objectId, remoteAccount.id)
				.first<FollowRequestResponseTarget>();
		}

		// Some servers embed an id-less Follow. In that case only, correlate by
		// both embedded actors; a mismatched or unknown object id never falls back.
		if (!followRequest && followObject && !followObject.id) {
			followRequest = await env.DB_META_C000.prepare(
				`SELECT fr.id, fr.account_id, fr.target_account_id, fr.uri,
				        local_initiator.uri AS local_initiator_uri,
				        response_owner.uri AS response_owner_uri
				 FROM follow_requests fr
				 JOIN accounts local_initiator ON local_initiator.id = fr.account_id
				 JOIN accounts response_owner ON response_owner.id = fr.target_account_id
				 WHERE fr.target_account_id = ?1
				   AND local_initiator.domain IS NULL
				 LIMIT 1`,
			)
				.bind(remoteAccount.id)
				.first<FollowRequestResponseTarget>();
		}

		if (!followRequest) {
			console.warn('[accept] No matching follow_request found');
			return;
		}
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

		const now = new Date().toISOString();
		const newFollowId = generateUlid();

		// Move from follow_requests to follows
		try {
			const [inserted, deleted] = await env.DB_META_C000.batch([
				env.DB_META_C000.prepare(
					`INSERT INTO follows
					   (id, account_id, target_account_id, uri, created_at, updated_at)
					 SELECT ?1, fr.account_id, fr.target_account_id, fr.uri, ?2, ?2
					 FROM follow_requests fr
					 WHERE fr.id = ?3
					   AND fr.account_id = ?4
					   AND fr.target_account_id = ?5`,
				).bind(
					newFollowId,
					now,
					followRequest.id,
					followRequest.account_id,
					followRequest.target_account_id,
				),
				env.DB_META_C000.prepare(
					`DELETE FROM follow_requests
					 WHERE id = ?1 AND account_id = ?2 AND target_account_id = ?3`,
				).bind(
					followRequest.id,
					followRequest.account_id,
					followRequest.target_account_id,
				),
			]);
			if ((inserted.meta?.changes ?? 0) !== 1 || (deleted.meta?.changes ?? 0) !== 1) {
				return;
			}

			await this.accountRepo.incrementCount(followRequest.account_id, 'following_count');
			await this.accountRepo.incrementCount(followRequest.target_account_id, 'followers_count');
		} catch (err) {
			console.error('[accept] Failed to move follow_request to follows:', err);
		}
	}

	private async processQuoteAccept(activity: APActivity, quoteRequest: APObject): Promise<void> {
		const instrumentUri = getId(quoteRequest.instrument);
		const quotedUri = getId(quoteRequest.object);
		const authorizationUri = getId(activity.result);
		if (!instrumentUri || !quotedUri || !authorizationUri) {
			console.warn('[accept] QuoteRequest Accept missing instrument, object, or result');
			return;
		}

		const responseActorAccountId = await this.resolveActor(activity.actor);
		if (!responseActorAccountId
			|| !await canAccountOriginateFederationActivity(responseActorAccountId)) {
			return;
		}

		const status = await env.DB_META_C000.prepare(
			`SELECT s.id, s.account_id AS local_quote_author_account_id,
			        s.quote_id, s.quote_approval_status, qs.uri AS quoted_uri,
			        qs.account_id AS quote_target_author_account_id
			 FROM statuses s
			 LEFT JOIN statuses qs ON qs.id = s.quote_id
			 WHERE s.uri = ?1 AND s.local = 1 AND s.deleted_at IS NULL
			 LIMIT 1`,
		).bind(instrumentUri).first<{
			id: string;
			local_quote_author_account_id: string;
			quote_id: string | null;
			quote_approval_status: string | null;
			quoted_uri: string | null;
			quote_target_author_account_id: string | null;
		}>();

		if (!status
			|| status.quoted_uri !== quotedUri
			|| !canApplyQuoteResponse({
				actorAccountId: responseActorAccountId,
				ownerAccountId: status.quote_target_author_account_id,
				localQuoteAuthorAccountId: status.local_quote_author_account_id,
				recipientAccountId: this.recipientAccountId || null,
				quoteApprovalStatus: status.quote_approval_status,
			})) {
			return;
		}

		const updated = await env.DB_META_C000.prepare(
			`UPDATE statuses
			 SET quote_authorization_uri = ?1, quote_approval_status = 'accepted', updated_at = ?2
			 WHERE id = ?3 AND quote_approval_status = 'pending'`,
		).bind(authorizationUri, new Date().toISOString(), status.id).run();
		if ((updated.meta?.changes ?? 0) === 0) return;

		await this.enqueueQuoteUpdate(status.id, authorizationUri);
	}

	private async enqueueQuoteUpdate(statusId: string, authorizationUri: string): Promise<void> {
		const row = await env.DB_META_C000.prepare(
			`SELECT s.id, s.uri, s.url, s.content, s.content_warning, s.visibility, s.sensitive,
			        s.language, s.created_at, s.quote_id, qs.uri AS quoted_uri,
			        a.id AS account_id, a.uri AS actor_uri, a.username
			 FROM statuses s
			 JOIN accounts a ON a.id = s.account_id
			 LEFT JOIN statuses qs ON qs.id = s.quote_id
			 WHERE s.id = ?1 AND s.local = 1 AND s.deleted_at IS NULL
			 LIMIT 1`,
		).bind(statusId).first<{
			id: string;
			uri: string;
			url: string | null;
			content: string;
			content_warning: string;
			visibility: string;
			sensitive: number;
			language: string;
			created_at: string;
			quote_id: string | null;
			quoted_uri: string | null;
			account_id: string;
			actor_uri: string;
			username: string;
		}>();
		if (!row?.quoted_uri) return;

		const followersUri = `${row.actor_uri}/followers`;
		const to: string[] = [];
		const cc: string[] = [];
		switch (row.visibility) {
			case 'public':
				to.push(AS_PUBLIC);
				cc.push(followersUri);
				break;
			case 'unlisted':
				to.push(followersUri);
				cc.push(AS_PUBLIC);
				break;
			case 'private':
				to.push(followersUri);
				break;
			default:
				return;
		}

		const note: Record<string, unknown> = {
			'@context': ['https://www.w3.org/ns/activitystreams', quoteContext()],
			type: 'Note',
			id: row.uri,
			attributedTo: row.actor_uri,
			to,
			cc,
			content: row.content,
			summary: row.content_warning || null,
			sensitive: row.sensitive === 1,
			published: row.created_at,
			url: row.url,
		};
		addQuoteProperties(note, row.quoted_uri, authorizationUri);

		const update = {
			'@context': ['https://www.w3.org/ns/activitystreams', quoteContext()],
			type: 'Update',
			id: `https://${env.INSTANCE_DOMAIN}/activities/${generateUlid()}`,
			actor: row.actor_uri,
			to,
			cc,
			object: note,
		};

		await env.QUEUE_FEDERATION.send({
			type: 'deliver_activity_fanout',
			activity: update,
			actorAccountId: row.account_id,
			statusId: row.id,
		});
	}
}

export async function processAccept(
	activity: APActivity,
	localAccountId: string,
): Promise<void> {
	await new AcceptProcessor(localAccountId).process(activity);
}
