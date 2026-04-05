/**
 * Inbox Processor: Block
 *
 * Handles incoming Block activities. Records the block, removes
 * any existing follow relationships in both directions, and updates
 * follower/following counts accordingly.
 */

import type { Env } from '../../env';
import type { APActivity } from '../../types/activitypub';
import { generateUlid } from '../../utils/ulid';
import { AccountRepository } from '../../repositories/account';

export async function processBlock(
	activity: APActivity,
	_localAccountId: string,
	env: Env,
): Promise<void> {
	const targetUri =
		typeof activity.object === 'string' ? activity.object : undefined;

	if (!targetUri) {
		console.warn('[block] activity.object is not a string URI');
		return;
	}

	const accountRepo = new AccountRepository(env.DB);

	// Resolve the actor (blocker)
	const actorAccount = await accountRepo.findByUri(activity.actor);
	if (!actorAccount) {
		console.warn(`[block] Actor not found: ${activity.actor}`);
		return;
	}

	// Resolve the target (blocked user)
	const targetAccount = await accountRepo.findByUri(targetUri);
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
		await accountRepo.decrementCount(actorAccount.id, 'following_count');
		await accountRepo.decrementCount(targetAccount.id, 'followers_count');
	}

	// Remove follow from target -> blocker
	const reverseFollow = await env.DB.prepare(
		`DELETE FROM follows WHERE account_id = ?1 AND target_account_id = ?2`,
	)
		.bind(targetAccount.id, actorAccount.id)
		.run();

	if ((reverseFollow.meta?.changes ?? 0) > 0) {
		await accountRepo.decrementCount(targetAccount.id, 'following_count');
		await accountRepo.decrementCount(actorAccount.id, 'followers_count');
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
