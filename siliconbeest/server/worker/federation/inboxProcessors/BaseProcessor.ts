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
import * as statusRepo from '../../repositories/status';
import * as accountRepo from '../../repositories/account';
import * as favouriteRepo from '../../repositories/favourite';
import type { Status, CreateStatusInput, TimelineOptions, AccountStatusOptions } from '../../repositories/status';
import type { Account, CreateAccountInput, UpdateAccountInput } from '../../repositories/account';
import type { Favourite, CreateFavouriteInput } from '../../repositories/favourite';
import { resolveRemoteAccount } from '../resolveRemoteAccount';

export type { Status } from '../../repositories/status';
export type { Account } from '../../repositories/account';

/**
 * Bound wrapper that exposes repo functions without requiring `db` on every call.
 * Keeps the same API surface as the old class-based repositories so federation
 * processors don't need changes.
 */
const bindStatusRepo = (db: D1Database) => ({
	findById: (id: string) => statusRepo.findById(db, id),
	findByUri: (uri: string) => statusRepo.findByUri(db, uri),
	findByAccountId: (accountId: string, opts?: AccountStatusOptions) => statusRepo.findByAccountId(db, accountId, opts),
	create: (input: CreateStatusInput) => statusRepo.create(db, input),
	update: (id: string, input: Partial<Omit<Status, 'id' | 'created_at' | 'updated_at'>>) => statusRepo.update(db, id, input),
	delete: (id: string) => statusRepo.deleteStatus(db, id),
	updateCounts: (id: string, counts: { replies_count?: number; reblogs_count?: number; favourites_count?: number }) => statusRepo.updateCounts(db, id, counts),
	incrementCount: (id: string, field: 'replies_count' | 'reblogs_count' | 'favourites_count') => statusRepo.incrementCount(db, id, field),
	decrementCount: (id: string, field: 'replies_count' | 'reblogs_count' | 'favourites_count') => statusRepo.decrementCount(db, id, field),
	softDeleteByAccount: (accountId: string) => statusRepo.softDeleteByAccount(db, accountId),
	findByUriIncludeDeleted: (uri: string) => statusRepo.findByUriIncludeDeleted(db, uri),
	findWithParent: (id: string) => statusRepo.findWithParent(db, id),
	findContext: (statusId: string) => statusRepo.findContext(db, statusId),
	findPublicTimeline: (opts?: TimelineOptions) => statusRepo.findPublicTimeline(db, opts),
	findLocalTimeline: (opts?: TimelineOptions) => statusRepo.findLocalTimeline(db, opts),
	findByTag: (tag: string, opts?: TimelineOptions) => statusRepo.findByTag(db, tag, opts),
});

const bindAccountRepo = (db: D1Database) => ({
	findById: (id: string) => accountRepo.findById(db, id),
	findByUri: (uri: string) => accountRepo.findByUri(db, uri),
	findByUsername: (username: string, domain?: string | null) => accountRepo.findByUsername(db, username, domain),
	findByIds: (ids: string[]) => accountRepo.findByIds(db, ids),
	create: (input: CreateAccountInput) => accountRepo.create(db, input),
	update: (id: string, input: UpdateAccountInput) => accountRepo.update(db, id, input),
	updateCounts: (id: string, counts: { statuses_count?: number; followers_count?: number; following_count?: number }) => accountRepo.updateCounts(db, id, counts),
	search: (query: string, limit?: number, offset?: number) => accountRepo.search(db, query, limit, offset),
	findLocalByUri: (uri: string) => accountRepo.findLocalByUri(db, uri),
	isLocal: (id: string) => accountRepo.isLocal(db, id),
	incrementCount: (id: string, field: 'followers_count' | 'following_count' | 'statuses_count') => accountRepo.incrementCount(db, id, field),
	decrementCount: (id: string, field: 'followers_count' | 'following_count' | 'statuses_count') => accountRepo.decrementCount(db, id, field),
	findLocalAccounts: (limit?: number, offset?: number) => accountRepo.findLocalAccounts(db, limit, offset),
});

const bindFavouriteRepo = (db: D1Database) => ({
	findByAccountAndStatus: (accountId: string, statusId: string) => favouriteRepo.findByAccountAndStatus(db, accountId, statusId),
	findByAccount: (accountId: string, limit?: number, maxId?: string) => favouriteRepo.findByAccount(db, accountId, limit, maxId),
	findByStatus: (statusId: string, limit?: number, maxId?: string) => favouriteRepo.findByStatus(db, statusId, limit, maxId),
	create: (input: CreateFavouriteInput) => favouriteRepo.create(db, input),
	delete: (id: string) => favouriteRepo.deleteById(db, id),
	findByUri: (uri: string) => favouriteRepo.findByUri(db, uri),
	deleteByAccountAndStatus: (accountId: string, statusId: string) => favouriteRepo.deleteByAccountAndStatus(db, accountId, statusId),
	countByStatus: (statusId: string) => favouriteRepo.countByStatus(db, statusId),
});

export abstract class BaseProcessor {
	protected readonly statusRepo;
	protected readonly accountRepo;
	protected readonly favouriteRepo;

	constructor(
		protected readonly env: Env,
	) {
		this.statusRepo = bindStatusRepo(env.DB);
		this.accountRepo = bindAccountRepo(env.DB);
		this.favouriteRepo = bindFavouriteRepo(env.DB);
	}

	// ============================================================
	// ENTITY RESOLUTION
	// ============================================================

	protected extractObjectUri(activity: APActivity): string | undefined {
		return typeof activity.object === 'string' ? activity.object : undefined;
	}

	protected async findStatusByUri(uri: string): Promise<Status | null> {
		return this.statusRepo.findByUri(uri);
	}

	protected async findAccountByUri(uri: string): Promise<Account | null> {
		return this.accountRepo.findByUri(uri);
	}

	protected async findLocalAccountByUri(uri: string): Promise<Account | null> {
		return this.accountRepo.findLocalByUri(uri);
	}

	protected async resolveActor(actorUri: string): Promise<string | null> {
		return resolveRemoteAccount(actorUri, this.env);
	}

	protected async isLocal(accountId: string): Promise<boolean> {
		return this.accountRepo.isLocal(accountId);
	}

	// ============================================================
	// NOTIFICATIONS
	// ============================================================

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
