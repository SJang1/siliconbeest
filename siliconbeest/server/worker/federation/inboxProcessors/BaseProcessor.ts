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

import { env } from 'cloudflare:workers';
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
 * Bound wrapper that exposes repo functions with a consistent object API.
 * Keeps the same API surface as the old class-based repositories so federation
 * processors don't need changes.
 */
const boundStatusRepo = {
	findById: (id: string) => statusRepo.findById(id),
	findByUri: (uri: string) => statusRepo.findByUri(uri),
	findByAccountId: (accountId: string, opts?: AccountStatusOptions) => statusRepo.findByAccountId(accountId, opts),
	create: (input: CreateStatusInput) => statusRepo.create(input),
	update: (id: string, input: Partial<Omit<Status, 'id' | 'created_at' | 'updated_at'>>) => statusRepo.update(id, input),
	delete: (id: string) => statusRepo.deleteStatus(id),
	updateCounts: (id: string, counts: { replies_count?: number; reblogs_count?: number; favourites_count?: number }) => statusRepo.updateCounts(id, counts),
	incrementCount: (id: string, field: 'replies_count' | 'reblogs_count' | 'favourites_count') => statusRepo.incrementCount(id, field),
	decrementCount: (id: string, field: 'replies_count' | 'reblogs_count' | 'favourites_count') => statusRepo.decrementCount(id, field),
	softDeleteByAccount: (accountId: string) => statusRepo.softDeleteByAccount(accountId),
	findByUriIncludeDeleted: (uri: string) => statusRepo.findByUriIncludeDeleted(uri),
	findWithParent: (id: string) => statusRepo.findWithParent(id),
	findContext: (statusId: string) => statusRepo.findContext(statusId),
	findPublicTimeline: (opts?: TimelineOptions) => statusRepo.findPublicTimeline(opts),
	findLocalTimeline: (opts?: TimelineOptions) => statusRepo.findLocalTimeline(opts),
	findByTag: (tag: string, opts?: TimelineOptions) => statusRepo.findByTag(tag, opts),
};

const boundAccountRepo = {
	findById: (id: string) => accountRepo.findById(id),
	findByUri: (uri: string) => accountRepo.findByUri(uri),
	findByUsername: (username: string, domain?: string | null) => accountRepo.findByUsername(username, domain),
	findByIds: (ids: string[]) => accountRepo.findByIds(ids),
	create: (input: CreateAccountInput) => accountRepo.create(input),
	update: (id: string, input: UpdateAccountInput) => accountRepo.update(id, input),
	updateCounts: (id: string, counts: { statuses_count?: number; followers_count?: number; following_count?: number }) => accountRepo.updateCounts(id, counts),
	search: (query: string, limit?: number, offset?: number) => accountRepo.search(query, limit, offset),
	findLocalByUri: (uri: string) => accountRepo.findLocalByUri(uri),
	isLocal: (id: string) => accountRepo.isLocal(id),
	incrementCount: (id: string, field: 'followers_count' | 'following_count' | 'statuses_count') => accountRepo.incrementCount(id, field),
	decrementCount: (id: string, field: 'followers_count' | 'following_count' | 'statuses_count') => accountRepo.decrementCount(id, field),
	findLocalAccounts: (limit?: number, offset?: number) => accountRepo.findLocalAccounts(limit, offset),
};

const boundFavouriteRepo = {
	findByAccountAndStatus: (accountId: string, statusId: string) => favouriteRepo.findByAccountAndStatus(accountId, statusId),
	findByAccount: (accountId: string, limit?: number, maxId?: string) => favouriteRepo.findByAccount(accountId, limit, maxId),
	findByStatus: (statusId: string, limit?: number, maxId?: string) => favouriteRepo.findByStatus(statusId, limit, maxId),
	create: (input: CreateFavouriteInput) => favouriteRepo.create(input),
	delete: (id: string) => favouriteRepo.deleteById(id),
	findByUri: (uri: string) => favouriteRepo.findByUri(uri),
	deleteByAccountAndStatus: (accountId: string, statusId: string) => favouriteRepo.deleteByAccountAndStatus(accountId, statusId),
	countByStatus: (statusId: string) => favouriteRepo.countByStatus(statusId),
};

export abstract class BaseProcessor {
	protected readonly statusRepo = boundStatusRepo;
	protected readonly accountRepo = boundAccountRepo;
	protected readonly favouriteRepo = boundFavouriteRepo;

	constructor() {}

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
		return resolveRemoteAccount(actorUri);
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
		await env.QUEUE_INTERNAL.send({
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
