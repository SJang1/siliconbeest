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

class AcceptProcessor extends BaseProcessor {
	async process(activity: APActivity): Promise<void> {
		const object = activity.object;
		if (!object) {
			console.warn('[accept] activity.object is missing');
			return;
		}

		// Relay Accept handling
		const followId = typeof object === 'string' ? object : (object as APObject).id;
		if (followId) {
			const relay = await env.DB.prepare(
				'SELECT id FROM relays WHERE follow_activity_id = ?1',
			)
				.bind(followId)
				.first<{ id: string }>();

			if (relay) {
				await env.DB.prepare(
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

		// Try to find the pending follow_request
		let followRequest: { id: string; account_id: string; target_account_id: string; uri: string | null } | null = null;

		if (typeof object === 'string') {
			followRequest = await env.DB.prepare(
				`SELECT id, account_id, target_account_id, uri FROM follow_requests
				 WHERE uri = ?1 LIMIT 1`,
			)
				.bind(object)
				.first();
		} else {
			const obj = object as APObject;
			if (obj.id) {
				followRequest = await env.DB.prepare(
					`SELECT id, account_id, target_account_id, uri FROM follow_requests
					 WHERE uri = ?1 LIMIT 1`,
				)
					.bind(obj.id)
					.first();
			}
		}

		// Fallback: find by account pair
		if (!followRequest) {
			followRequest = await env.DB.prepare(
				`SELECT id, account_id, target_account_id, uri FROM follow_requests
				 WHERE target_account_id = ?1
				 AND account_id IN (SELECT id FROM accounts WHERE domain IS NULL)
				 LIMIT 1`,
			)
				.bind(remoteAccount.id)
				.first();
		}

		if (!followRequest) {
			console.warn('[accept] No matching follow_request found');
			return;
		}

		const now = new Date().toISOString();
		const newFollowId = generateUlid();

		// Move from follow_requests to follows
		try {
			await env.DB.batch([
				env.DB.prepare(
					`INSERT INTO follows (id, account_id, target_account_id, uri, created_at, updated_at)
					 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
				).bind(newFollowId, followRequest.account_id, followRequest.target_account_id, followRequest.uri, now, now),
				env.DB.prepare(
					`DELETE FROM follow_requests WHERE id = ?1`,
				).bind(followRequest.id),
			]);

			await this.accountRepo.incrementCount(followRequest.account_id, 'following_count');
			await this.accountRepo.incrementCount(followRequest.target_account_id, 'followers_count');
		} catch (err) {
			console.error('[accept] Failed to move follow_request to follows:', err);
		}
	}
}

export async function processAccept(
	activity: APActivity,
	_localAccountId: string,
): Promise<void> {
	await new AcceptProcessor().process(activity);
}
