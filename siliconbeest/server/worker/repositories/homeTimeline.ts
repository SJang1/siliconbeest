import { generateUlid } from '../utils/ulid';

export interface HomeTimelineEntry {
	id: string;
	account_id: string;
	status_id: string;
	created_at: string;
}

export class HomeTimelineRepository {
	constructor(private db: D1Database) {}

	async findByAccount(
		accountId: string,
		limit: number = 20,
		maxId?: string,
		sinceId?: string
	): Promise<HomeTimelineEntry[]> {
		const conditions: string[] = ['account_id = ?'];
		const values: unknown[] = [accountId];

		if (maxId) {
			conditions.push('id < ?');
			values.push(maxId);
		}
		if (sinceId) {
			conditions.push('id > ?');
			values.push(sinceId);
		}

		values.push(limit);

		const { results } = await this.db
			.prepare(
				`SELECT * FROM home_timeline_entries
				 WHERE ${conditions.join(' AND ')}
				 ORDER BY id DESC LIMIT ?`
			)
			.bind(...values)
			.all<HomeTimelineEntry>();
		return results;
	}

	async insert(accountId: string, statusId: string): Promise<HomeTimelineEntry> {
		const now = new Date().toISOString();
		const id = generateUlid();
		const entry: HomeTimelineEntry = {
			id,
			account_id: accountId,
			status_id: statusId,
			created_at: now,
		};

		await this.db
			.prepare(
				`INSERT OR IGNORE INTO home_timeline_entries (id, account_id, status_id, created_at)
				 VALUES (?, ?, ?, ?)`
			)
			.bind(entry.id, entry.account_id, entry.status_id, entry.created_at)
			.run();

		return entry;
	}

	async insertBatch(accountId: string, statusIds: string[]): Promise<void> {
		if (statusIds.length === 0) return;
		const now = new Date().toISOString();

		const stmts = statusIds.map((statusId) => {
			const id = generateUlid();
			return this.db
				.prepare(
					`INSERT OR IGNORE INTO home_timeline_entries (id, account_id, status_id, created_at)
					 VALUES (?, ?, ?, ?)`
				)
				.bind(id, accountId, statusId, now);
		});

		await this.db.batch(stmts);
	}

	async deleteByStatus(statusId: string): Promise<void> {
		await this.db
			.prepare('DELETE FROM home_timeline_entries WHERE status_id = ?')
			.bind(statusId)
			.run();
	}

	async deleteByAccount(accountId: string): Promise<void> {
		await this.db
			.prepare('DELETE FROM home_timeline_entries WHERE account_id = ?')
			.bind(accountId)
			.run();
	}
}
