import { generateUlid } from '../utils/ulid';

export interface Favourite {
	id: string;
	account_id: string;
	status_id: string;
	uri: string | null;
	created_at: string;
}

export interface CreateFavouriteInput {
	account_id: string;
	status_id: string;
	uri?: string | null;
}

export class FavouriteRepository {
	constructor(private db: D1Database) {}

	async findByAccountAndStatus(accountId: string, statusId: string): Promise<Favourite | null> {
		const result = await this.db
			.prepare('SELECT * FROM favourites WHERE account_id = ? AND status_id = ?')
			.bind(accountId, statusId)
			.first<Favourite>();
		return result ?? null;
	}

	async findByAccount(accountId: string, limit: number = 20, maxId?: string): Promise<Favourite[]> {
		const conditions: string[] = ['account_id = ?'];
		const values: unknown[] = [accountId];

		if (maxId) {
			conditions.push('id < ?');
			values.push(maxId);
		}

		values.push(limit);

		const { results } = await this.db
			.prepare(
				`SELECT * FROM favourites
				 WHERE ${conditions.join(' AND ')}
				 ORDER BY id DESC LIMIT ?`
			)
			.bind(...values)
			.all<Favourite>();
		return results;
	}

	async findByStatus(statusId: string, limit: number = 20, maxId?: string): Promise<Favourite[]> {
		const conditions: string[] = ['status_id = ?'];
		const values: unknown[] = [statusId];

		if (maxId) {
			conditions.push('id < ?');
			values.push(maxId);
		}

		values.push(limit);

		const { results } = await this.db
			.prepare(
				`SELECT * FROM favourites
				 WHERE ${conditions.join(' AND ')}
				 ORDER BY id DESC LIMIT ?`
			)
			.bind(...values)
			.all<Favourite>();
		return results;
	}

	async create(input: CreateFavouriteInput): Promise<Favourite> {
		const now = new Date().toISOString();
		const id = generateUlid();
		const favourite: Favourite = {
			id,
			account_id: input.account_id,
			status_id: input.status_id,
			uri: input.uri ?? null,
			created_at: now,
		};

		await this.db
			.prepare(
				'INSERT INTO favourites (id, account_id, status_id, uri, created_at) VALUES (?, ?, ?, ?, ?)'
			)
			.bind(favourite.id, favourite.account_id, favourite.status_id, favourite.uri, favourite.created_at)
			.run();

		return favourite;
	}

	async delete(id: string): Promise<void> {
		await this.db
			.prepare('DELETE FROM favourites WHERE id = ?')
			.bind(id)
			.run();
	}

	async countByStatus(statusId: string): Promise<number> {
		const result = await this.db
			.prepare('SELECT COUNT(*) as count FROM favourites WHERE status_id = ?')
			.bind(statusId)
			.first<{ count: number }>();
		return result?.count ?? 0;
	}
}
