import { generateUlid } from '../utils/ulid';

export interface Mention {
	id: string;
	status_id: string;
	account_id: string;
	silent: number;
	created_at: string;
}

export interface CreateMentionInput {
	status_id: string;
	account_id: string;
	silent?: number;
}

export class MentionRepository {
	constructor(private db: D1Database) {}

	async findByStatusId(statusId: string): Promise<Mention[]> {
		const { results } = await this.db
			.prepare('SELECT * FROM mentions WHERE status_id = ? ORDER BY created_at ASC')
			.bind(statusId)
			.all<Mention>();
		return results;
	}

	async findByAccountId(accountId: string, limit: number = 20, maxId?: string): Promise<Mention[]> {
		const conditions: string[] = ['account_id = ?'];
		const values: unknown[] = [accountId];

		if (maxId) {
			conditions.push('id < ?');
			values.push(maxId);
		}

		values.push(limit);

		const { results } = await this.db
			.prepare(
				`SELECT * FROM mentions
				 WHERE ${conditions.join(' AND ')}
				 ORDER BY id DESC LIMIT ?`
			)
			.bind(...values)
			.all<Mention>();
		return results;
	}

	async create(input: CreateMentionInput): Promise<Mention> {
		const now = new Date().toISOString();
		const id = generateUlid();
		const mention: Mention = {
			id,
			status_id: input.status_id,
			account_id: input.account_id,
			silent: input.silent ?? 0,
			created_at: now,
		};

		await this.db
			.prepare(
				'INSERT OR IGNORE INTO mentions (id, status_id, account_id, silent, created_at) VALUES (?, ?, ?, ?, ?)'
			)
			.bind(mention.id, mention.status_id, mention.account_id, mention.silent, mention.created_at)
			.run();

		return mention;
	}

	async createBatch(mentions: CreateMentionInput[]): Promise<void> {
		if (mentions.length === 0) return;
		const now = new Date().toISOString();

		const stmts = mentions.map((input) => {
			const id = generateUlid();
			return this.db
				.prepare(
					'INSERT OR IGNORE INTO mentions (id, status_id, account_id, silent, created_at) VALUES (?, ?, ?, ?, ?)'
				)
				.bind(id, input.status_id, input.account_id, input.silent ?? 0, now);
		});

		await this.db.batch(stmts);
	}
}
