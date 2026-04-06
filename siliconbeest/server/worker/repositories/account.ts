import { env } from 'cloudflare:workers';
import { generateUlid } from '../utils/ulid';

export type Account = {
	id: string;
	username: string;
	domain: string | null;
	display_name: string;
	note: string;
	uri: string;
	url: string | null;
	avatar_url: string;
	avatar_static_url: string;
	header_url: string;
	header_static_url: string;
	inbox_url: string | null;
	shared_inbox_url: string | null;
	locked: number;
	bot: number;
	discoverable: number;
	manually_approves_followers: number;
	statuses_count: number;
	followers_count: number;
	following_count: number;
	last_status_at: string | null;
	created_at: string;
	updated_at: string;
	suspended_at: string | null;
	silenced_at: string | null;
	memorial: number;
	moved_to_account_id: string | null;
};

export type CreateAccountInput = Pick<Account, 'username' | 'uri'> &
	Partial<Omit<Account, 'id' | 'created_at' | 'updated_at'>>;

export type UpdateAccountInput = Partial<
	Omit<Account, 'id' | 'created_at' | 'updated_at'>
>;

export const findById = async (id: string): Promise<Account | null> => {
	const result = await env.DB
		.prepare('SELECT * FROM accounts WHERE id = ?')
		.bind(id)
		.first<Account>();
	return result ?? null;
};

export const findByUri = async (uri: string): Promise<Account | null> => {
	const result = await env.DB
		.prepare('SELECT * FROM accounts WHERE uri = ?')
		.bind(uri)
		.first<Account>();
	return result ?? null;
};

export const findByUsername = async (username: string, domain?: string | null): Promise<Account | null> => {
	if (domain === undefined || domain === null) {
		const result = await env.DB
			.prepare('SELECT * FROM accounts WHERE username = ? AND domain IS NULL')
			.bind(username)
			.first<Account>();
		return result ?? null;
	}
	const result = await env.DB
		.prepare('SELECT * FROM accounts WHERE username = ? AND domain = ?')
		.bind(username, domain)
		.first<Account>();
	return result ?? null;
};

export const findByIds = async (ids: string[]): Promise<Account[]> => {
	if (ids.length === 0) return [];
	const placeholders = ids.map(() => '?').join(', ');
	const { results } = await env.DB
		.prepare(`SELECT * FROM accounts WHERE id IN (${placeholders})`)
		.bind(...ids)
		.all<Account>();
	return results;
};

export const create = async (input: CreateAccountInput): Promise<Account> => {
	const now = new Date().toISOString();
	const id = generateUlid();
	const account: Account = {
		id,
		username: input.username,
		domain: input.domain ?? null,
		display_name: input.display_name ?? '',
		note: input.note ?? '',
		uri: input.uri,
		url: input.url ?? null,
		avatar_url: input.avatar_url ?? '',
		avatar_static_url: input.avatar_static_url ?? '',
		header_url: input.header_url ?? '',
		header_static_url: input.header_static_url ?? '',
		inbox_url: input.inbox_url ?? null,
		shared_inbox_url: input.shared_inbox_url ?? null,
		locked: input.locked ?? 0,
		bot: input.bot ?? 0,
		discoverable: input.discoverable ?? 1,
		manually_approves_followers: input.manually_approves_followers ?? 0,
		statuses_count: input.statuses_count ?? 0,
		followers_count: input.followers_count ?? 0,
		following_count: input.following_count ?? 0,
		last_status_at: input.last_status_at ?? null,
		created_at: now,
		updated_at: now,
		suspended_at: input.suspended_at ?? null,
		silenced_at: input.silenced_at ?? null,
		memorial: input.memorial ?? 0,
		moved_to_account_id: input.moved_to_account_id ?? null,
	};

	await env.DB
		.prepare(
			`INSERT INTO accounts (
				id, username, domain, display_name, note, uri, url,
				avatar_url, avatar_static_url, header_url, header_static_url,
				inbox_url, shared_inbox_url,
				locked, bot, discoverable, manually_approves_followers,
				statuses_count, followers_count, following_count,
				last_status_at, created_at, updated_at,
				suspended_at, silenced_at, memorial, moved_to_account_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			account.id, account.username, account.domain,
			account.display_name, account.note, account.uri, account.url,
			account.avatar_url, account.avatar_static_url,
			account.header_url, account.header_static_url,
			account.inbox_url, account.shared_inbox_url,
			account.locked, account.bot, account.discoverable,
			account.manually_approves_followers,
			account.statuses_count, account.followers_count, account.following_count,
			account.last_status_at, account.created_at, account.updated_at,
			account.suspended_at, account.silenced_at, account.memorial,
			account.moved_to_account_id
		)
		.run();

	return account;
};

export const update = async (id: string, input: UpdateAccountInput): Promise<Account | null> => {
	const now = new Date().toISOString();
	const entries = Object.entries(input);
	const fields = [...entries.map(([key]) => `${key} = ?`), 'updated_at = ?'];
	const values = [...entries.map(([, value]) => value), now, id];

	await env.DB
		.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`)
		.bind(...values)
		.run();

	return findById(id);
};

export const updateCounts = async (
	id: string,
	counts: { statuses_count?: number; followers_count?: number; following_count?: number }
): Promise<void> => {
	const entries = Object.entries(counts).filter(([, v]) => v !== undefined);

	if (entries.length === 0) return;

	const fields = [...entries.map(([key]) => `${key} = ?`), 'updated_at = ?'];
	const values = [...entries.map(([, value]) => value), new Date().toISOString(), id];

	await env.DB
		.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`)
		.bind(...values)
		.run();
};

export const search = async (query: string, limit: number = 20, offset: number = 0): Promise<Account[]> => {
	const likeQuery = `%${query}%`;
	const { results } = await env.DB
		.prepare(
			`SELECT * FROM accounts
			 WHERE (username LIKE ? OR display_name LIKE ?)
			 ORDER BY
				 CASE WHEN domain IS NULL THEN 0 ELSE 1 END,
				 followers_count DESC
			 LIMIT ? OFFSET ?`
		)
		.bind(likeQuery, likeQuery, limit, offset)
		.all<Account>();
	return results;
};

/**
 * Find a local account by its URI (domain IS NULL).
 * Used by federation processors to verify the target is a local user.
 */
export const findLocalByUri = async (uri: string): Promise<Account | null> => {
	const result = await env.DB
		.prepare('SELECT * FROM accounts WHERE uri = ? AND domain IS NULL')
		.bind(uri)
		.first<Account>();
	return result ?? null;
};

/**
 * Check if an account ID belongs to a local user.
 */
export const isLocal = async (id: string): Promise<boolean> => {
	const result = await env.DB
		.prepare('SELECT id FROM accounts WHERE id = ? AND domain IS NULL')
		.bind(id)
		.first();
	return result !== null;
};

/**
 * Increment a count field atomically. Used by federation inbox processors.
 */
export const incrementCount = async (id: string, field: 'followers_count' | 'following_count' | 'statuses_count'): Promise<void> => {
	await env.DB
		.prepare(`UPDATE accounts SET ${field} = ${field} + 1, updated_at = ? WHERE id = ?`)
		.bind(new Date().toISOString(), id)
		.run();
};

/**
 * Decrement a count field atomically, flooring at 0.
 */
export const decrementCount = async (id: string, field: 'followers_count' | 'following_count' | 'statuses_count'): Promise<void> => {
	await env.DB
		.prepare(`UPDATE accounts SET ${field} = MAX(0, ${field} - 1), updated_at = ? WHERE id = ?`)
		.bind(new Date().toISOString(), id)
		.run();
};

export const findLocalAccounts = async (limit: number = 20, offset: number = 0): Promise<Account[]> => {
	const { results } = await env.DB
		.prepare(
			'SELECT * FROM accounts WHERE domain IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?'
		)
		.bind(limit, offset)
		.all<Account>();
	return results;
};
