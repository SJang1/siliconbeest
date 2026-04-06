/**
 * Inbox Processor: Block
 *
 * Handles incoming Block activities. Records the block, removes
 * any existing follow relationships in both directions, and updates
 * follower/following counts accordingly.
 */

import { env } from 'cloudflare:workers';
import type { APActivity } from '../../types/activitypub';
import { generateUlid } from '../../utils/ulid';
import { BaseProcessor } from './BaseProcessor';

class BlockProcessor extends BaseProcessor {
	async process(activity: APActivity): Promise<void> {
		const targetUri = this.extractObjectUri(activity);

		if (!targetUri) {
			console.warn('[block] activity.object is not a string URI');
			return;
		}

		// Resolve the actor (blocker)
		const actorAccount = await this.findAccountByUri(activity.actor);
		if (!actorAccount) {
			console.warn(`[block] Actor not found: ${activity.actor}`);
			return;
		}

		// Resolve the target (blocked user)
		const targetAccount = await this.findAccountByUri(targetUri);
		if (!targetAccount) {
			console.warn(`[block] Target not found: ${targetUri}`);
			return;
		}

		const now = new Date().toISOString();
		const blockId = generateUlid();

		// Insert block record (ignore if duplicate)
		try {
			await env.DB.prepare(
				`INSERT INTO blocks (id, account_id, target_account_id, uri, created_at)
				 VALUES (?1, ?2, ?3, ?4, ?5)`,
			)
				.bind(blockId, actorAccount.id, targetAccount.id, activity.id ?? null, now)
				.run();
		} catch {
			// Duplicate block, ignore
			return;
		}

		// Remove follow from blocker -> target
		const forwardFollow = await env.DB.prepare(
			`DELETE FROM follows WHERE account_id = ?1 AND target_account_id = ?2`,
		)
			.bind(actorAccount.id, targetAccount.id)
			.run();

		if ((forwardFollow.meta?.changes ?? 0) > 0) {
			await this.accountRepo.decrementCount(actorAccount.id, 'following_count');
			await this.accountRepo.decrementCount(targetAccount.id, 'followers_count');
		}

		// Remove follow from target -> blocker
		const reverseFollow = await env.DB.prepare(
			`DELETE FROM follows WHERE account_id = ?1 AND target_account_id = ?2`,
		)
			.bind(targetAccount.id, actorAccount.id)
			.run();

		if ((reverseFollow.meta?.changes ?? 0) > 0) {
			await this.accountRepo.decrementCount(targetAccount.id, 'following_count');
			await this.accountRepo.decrementCount(actorAccount.id, 'followers_count');
		}

		// Also remove pending follow_requests in both directions
		await env.DB.batch([
			env.DB.prepare(
				`DELETE FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2`,
			).bind(actorAccount.id, targetAccount.id),
			env.DB.prepare(
				`DELETE FROM follow_requests WHERE account_id = ?1 AND target_account_id = ?2`,
			).bind(targetAccount.id, actorAccount.id),
		]);
	}
}

export async function processBlock(
	activity: APActivity,
	_localAccountId: string,
): Promise<void> {
	await new BlockProcessor().process(activity);
}
