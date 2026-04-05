/**
 * BaseProcessor - Shared infrastructure for inbox activity processing.
 *
 * Every inbox processor follows the same pattern:
 *   1. Extract target URI from activity.object
 *   2. Find the local entity (status/account) by URI
 *   3. Resolve the remote actor via resolveRemoteAccount()
 *   4. Perform the domain-specific operation
 *   5. If the affected entity belongs to a local user, enqueue a notification
 *
 * This base class provides reusable methods for steps 1-3 and 5,
 * so each processor only needs to implement step 4.
 */

import type { Env } from '../../env';
import type { APActivity } from '../../types/activitypub';
import { StatusRepository, type Status } from '../../repositories/status';
import { AccountRepository, type Account } from '../../repositories/account';
import { FavouriteRepository } from '../../repositories/favourite';
import { resolveRemoteAccount } from '../resolveRemoteAccount';

export abstract class BaseProcessor {
	protected readonly statusRepo: StatusRepository;
	protected readonly accountRepo: AccountRepository;
	protected readonly favouriteRepo: FavouriteRepository;

	constructor(
		protected readonly env: Env,
	) {
		this.statusRepo = new StatusRepository(env.DB);
		this.accountRepo = new AccountRepository(env.DB);
		this.favouriteRepo = new FavouriteRepository(env.DB);
	}

	// ============================================================
	// ENTITY RESOLUTION
	// ============================================================

	/**
	 * Extract the object URI from an activity.
	 * Returns the URI string if object is a string, otherwise undefined.
	 */
	protected extractObjectUri(activity: APActivity): string | undefined {
		return typeof activity.object === 'string' ? activity.object : undefined;
	}

	/**
	 * Find a status by its ActivityPub URI.
	 */
	protected async findStatusByUri(uri: string): Promise<Status | null> {
		return this.statusRepo.findByUri(uri);
	}

	/**
	 * Find an account by its ActivityPub URI.
	 */
	protected async findAccountByUri(uri: string): Promise<Account | null> {
		return this.accountRepo.findByUri(uri);
	}

	/**
	 * Find a local account by its ActivityPub URI.
	 */
	protected async findLocalAccountByUri(uri: string): Promise<Account | null> {
		return this.accountRepo.findLocalByUri(uri);
	}

	/**
	 * Resolve a remote actor URI to a local account ID.
	 * Fetches the actor from the remote server if not already known.
	 */
	protected async resolveActor(actorUri: string): Promise<string | null> {
		return resolveRemoteAccount(actorUri, this.env);
	}

	/**
	 * Check if an account ID belongs to a local user.
	 */
	protected async isLocal(accountId: string): Promise<boolean> {
		return this.accountRepo.isLocal(accountId);
	}

	// ============================================================
	// NOTIFICATIONS
	// ============================================================

	/**
	 * Enqueue a notification for a local user.
	 */
	protected async notify(
		type: string,
		recipientAccountId: string,
		senderAccountId: string,
		statusId?: string,
	): Promise<void> {
		await this.env.QUEUE_INTERNAL.send({
			type: 'create_notification',
			recipientAccountId,
			senderAccountId,
			notificationType: type,
			...(statusId ? { statusId } : {}),
		});
	}

	/**
	 * Enqueue a notification only if the recipient is a local user.
	 */
	protected async notifyIfLocal(
		type: string,
		recipientAccountId: string,
		senderAccountId: string,
		statusId?: string,
	): Promise<void> {
		if (await this.isLocal(recipientAccountId)) {
			await this.notify(type, recipientAccountId, senderAccountId, statusId);
		}
	}
}
