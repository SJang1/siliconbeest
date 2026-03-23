import { generateUlid } from '../utils/ulid';

export interface Follow {
	id: string;
	account_id: string;
	target_account_id: string;
	uri: string | null;
	show_reblogs: number;
	notify: number;
	languages: string | null;
	created_at: string;
	updated_at: string;
}

export interface CreateFollowInput {
	account_id: string;
	target_account_id: string;
	uri?: string | null;
	show_reblogs?: number;
	notify?: number;
	languages?: string | null;
}

export class FollowRepository {
	constructor(private db: D1Database) {}

	async findById(id: string): Promise<Follow | null> {
		const result = await this.db
			.prepare('SELECT * FROM follows WHERE id = ?')
			.bind(id)
			.first<Follow>();
		return result ?? null;
	}

	async findByAccountAndTarget(accountId: string, targetAccountId: string): Promise<Follow | null> {
		const result = await this.db
			.prepare('SELECT * FROM follows WHERE account_id = ? AND target_account_id = ?')
			.bind(accountId, targetAccountId)
			.first<Follow>();
		return result ?? null;
	}

	async findFollowers(accountId: string, limit: number = 40, maxId?: string): Promise<Follow[]> {
		const conditions: string[] = ['target_account_id = ?'];
		const values: unknown[] = [accountId];

		if (maxId) {
			conditions.push('id < ?');
			values.push(maxId);
		}

		values.push(limit);

		const { results } = await this.db
			.prepare(
				`SELECT * FROM follows
				 WHERE ${conditions.join(' AND ')}
				 ORDER BY id DESC LIMIT ?`
			)
			.bind(...values)
			.all<Follow>();
		return results;
	}

	async findFollowing(accountId: string, limit: number = 40, maxId?: string): Promise<Follow[]> {
		const conditions: string[] = ['account_id = ?'];
		const values: unknown[] = [accountId];

		if (maxId) {
			conditions.push('id < ?');
			values.push(maxId);
		}

		values.push(limit);

		const { results } = await this.db
			.prepare(
				`SELECT * FROM follows
				 WHERE ${conditions.join(' AND ')}
				 ORDER BY id DESC LIMIT ?`
			)
			.bind(...values)
			.all<Follow>();
		return results;
	}

	async create(input: CreateFollowInput): Promise<Follow> {
		const now = new Date().toISOString();
		const id = generateUlid();
		const follow: Follow = {
			id,
			account_id: input.account_id,
			target_account_id: input.target_account_id,
			uri: input.uri ?? null,
			show_reblogs: input.show_reblogs ?? 1,
			notify: input.notify ?? 0,
			languages: input.languages ?? null,
			created_at: now,
			updated_at: now,
		};

		await this.db
			.prepare(
				`INSERT INTO follows (
					id, account_id, target_account_id, uri,
					show_reblogs, notify, languages, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				follow.id, follow.account_id, follow.target_account_id, follow.uri,
				follow.show_reblogs, follow.notify, follow.languages,
				follow.created_at, follow.updated_at
			)
			.run();

		return follow;
	}

	async delete(id: string): Promise<void> {
		await this.db
			.prepare('DELETE FROM follows WHERE id = ?')
			.bind(id)
			.run();
	}

	async countFollowers(accountId: string): Promise<number> {
		const result = await this.db
			.prepare('SELECT COUNT(*) as count FROM follows WHERE target_account_id = ?')
			.bind(accountId)
			.first<{ count: number }>();
		return result?.count ?? 0;
	}

	async countFollowing(accountId: string): Promise<number> {
		const result = await this.db
			.prepare('SELECT COUNT(*) as count FROM follows WHERE account_id = ?')
			.bind(accountId)
			.first<{ count: number }>();
		return result?.count ?? 0;
	}

	async findRemoteFollowerInboxes(accountId: string): Promise<string[]> {
		const { results } = await this.db
			.prepare(
				`SELECT DISTINCT a.uri FROM follows f
				 JOIN accounts a ON a.id = f.account_id
				 WHERE f.target_account_id = ? AND a.domain IS NOT NULL`
			)
			.bind(accountId)
			.all<{ uri: string }>();

		// Derive inbox URLs from actor URIs: {actor_uri}/inbox
		// In practice, the inbox URL is stored on the instance or fetched via WebFinger.
		// This returns the actor URIs; the caller should resolve to shared inboxes.
		return [...new Set(results.map((r) => r.uri))];
	}
}
