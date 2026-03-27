import { generateUlid } from '../utils/ulid';

export interface Bookmark {
	id: string;
	account_id: string;
	status_id: string;
	created_at: string;
}

export interface CreateBookmarkInput {
	account_id: string;
	status_id: string;
}

export class BookmarkRepository {
	constructor(private db: D1Database) {}

	async findByAccountAndStatus(accountId: string, statusId: string): Promise<Bookmark | null> {
		const result = await this.db
			.prepare('SELECT * FROM bookmarks WHERE account_id = ? AND status_id = ?')
			.bind(accountId, statusId)
			.first<Bookmark>();
		return result ?? null;
	}

	async findByAccount(accountId: string, limit: number = 20, maxId?: string): Promise<Bookmark[]> {
		const conditions: string[] = ['account_id = ?'];
		const values: unknown[] = [accountId];

		if (maxId) {
			conditions.push('id < ?');
			values.push(maxId);
		}

		values.push(limit);

		const { results } = await this.db
			.prepare(
				`SELECT * FROM bookmarks
				 WHERE ${conditions.join(' AND ')}
				 ORDER BY id DESC LIMIT ?`
			)
			.bind(...values)
			.all<Bookmark>();
		return results;
	}

	async create(input: CreateBookmarkInput): Promise<Bookmark> {
		const now = new Date().toISOString();
		const id = generateUlid();
		const bookmark: Bookmark = {
			id,
			account_id: input.account_id,
			status_id: input.status_id,
			created_at: now,
		};

		await this.db
			.prepare(
				'INSERT INTO bookmarks (id, account_id, status_id, created_at) VALUES (?, ?, ?, ?)'
			)
			.bind(bookmark.id, bookmark.account_id, bookmark.status_id, bookmark.created_at)
			.run();

		return bookmark;
	}

	async delete(id: string): Promise<void> {
		await this.db
			.prepare('DELETE FROM bookmarks WHERE id = ?')
			.bind(id)
			.run();
	}
}
