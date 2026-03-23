import { generateUlid } from '../utils/ulid';

export interface Account {
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
}

export type CreateAccountInput = Pick<Account, 'username' | 'uri'> &
	Partial<Omit<Account, 'id' | 'created_at' | 'updated_at'>>;

export type UpdateAccountInput = Partial<
	Omit<Account, 'id' | 'created_at' | 'updated_at'>
>;

export class AccountRepository {
	constructor(private db: D1Database) {}

	async findById(id: string): Promise<Account | null> {
		const result = await this.db
			.prepare('SELECT * FROM accounts WHERE id = ?')
			.bind(id)
			.first<Account>();
		return result ?? null;
	}

	async findByUri(uri: string): Promise<Account | null> {
		const result = await this.db
			.prepare('SELECT * FROM accounts WHERE uri = ?')
			.bind(uri)
			.first<Account>();
		return result ?? null;
	}

	async findByUsername(username: string, domain?: string | null): Promise<Account | null> {
		if (domain === undefined || domain === null) {
			const result = await this.db
				.prepare('SELECT * FROM accounts WHERE username = ? AND domain IS NULL')
				.bind(username)
				.first<Account>();
			return result ?? null;
		}
		const result = await this.db
			.prepare('SELECT * FROM accounts WHERE username = ? AND domain = ?')
			.bind(username, domain)
			.first<Account>();
		return result ?? null;
	}

	async findByIds(ids: string[]): Promise<Account[]> {
		if (ids.length === 0) return [];
		const placeholders = ids.map(() => '?').join(', ');
		const { results } = await this.db
			.prepare(`SELECT * FROM accounts WHERE id IN (${placeholders})`)
			.bind(...ids)
			.all<Account>();
		return results;
	}

	async create(input: CreateAccountInput): Promise<Account> {
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

		await this.db
			.prepare(
				`INSERT INTO accounts (
					id, username, domain, display_name, note, uri, url,
					avatar_url, avatar_static_url, header_url, header_static_url,
					locked, bot, discoverable, manually_approves_followers,
					statuses_count, followers_count, following_count,
					last_status_at, created_at, updated_at,
					suspended_at, silenced_at, memorial, moved_to_account_id
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				account.id, account.username, account.domain,
				account.display_name, account.note, account.uri, account.url,
				account.avatar_url, account.avatar_static_url,
				account.header_url, account.header_static_url,
				account.locked, account.bot, account.discoverable,
				account.manually_approves_followers,
				account.statuses_count, account.followers_count, account.following_count,
				account.last_status_at, account.created_at, account.updated_at,
				account.suspended_at, account.silenced_at, account.memorial,
				account.moved_to_account_id
			)
			.run();

		return account;
	}

	async update(id: string, input: UpdateAccountInput): Promise<Account | null> {
		const now = new Date().toISOString();
		const fields: string[] = [];
		const values: unknown[] = [];

		for (const [key, value] of Object.entries(input)) {
			fields.push(`${key} = ?`);
			values.push(value);
		}

		fields.push('updated_at = ?');
		values.push(now);
		values.push(id);

		await this.db
			.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`)
			.bind(...values)
			.run();

		return this.findById(id);
	}

	async updateCounts(
		id: string,
		counts: { statuses_count?: number; followers_count?: number; following_count?: number }
	): Promise<void> {
		const fields: string[] = [];
		const values: unknown[] = [];

		if (counts.statuses_count !== undefined) {
			fields.push('statuses_count = ?');
			values.push(counts.statuses_count);
		}
		if (counts.followers_count !== undefined) {
			fields.push('followers_count = ?');
			values.push(counts.followers_count);
		}
		if (counts.following_count !== undefined) {
			fields.push('following_count = ?');
			values.push(counts.following_count);
		}

		if (fields.length === 0) return;

		fields.push('updated_at = ?');
		values.push(new Date().toISOString());
		values.push(id);

		await this.db
			.prepare(`UPDATE accounts SET ${fields.join(', ')} WHERE id = ?`)
			.bind(...values)
			.run();
	}

	async search(query: string, limit: number = 20, offset: number = 0): Promise<Account[]> {
		const likeQuery = `%${query}%`;
		const { results } = await this.db
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
	}

	async findLocalAccounts(limit: number = 20, offset: number = 0): Promise<Account[]> {
		const { results } = await this.db
			.prepare(
				'SELECT * FROM accounts WHERE domain IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?'
			)
			.bind(limit, offset)
			.all<Account>();
		return results;
	}
}
