import { generateUlid } from '../utils/ulid';

export interface Block {
	id: string;
	account_id: string;
	target_account_id: string;
	uri: string | null;
	created_at: string;
}

export interface CreateBlockInput {
	account_id: string;
	target_account_id: string;
	uri?: string | null;
}

export class BlockRepository {
	constructor(private db: D1Database) {}

	async findByAccountAndTarget(accountId: string, targetAccountId: string): Promise<Block | null> {
		const result = await this.db
			.prepare('SELECT * FROM blocks WHERE account_id = ? AND target_account_id = ?')
			.bind(accountId, targetAccountId)
			.first<Block>();
		return result ?? null;
	}

	async findByAccount(accountId: string, limit: number = 40, maxId?: string): Promise<Block[]> {
		const conditions: string[] = ['account_id = ?'];
		const values: unknown[] = [accountId];

		if (maxId) {
			conditions.push('id < ?');
			values.push(maxId);
		}

		values.push(limit);

		const { results } = await this.db
			.prepare(
				`SELECT * FROM blocks
				 WHERE ${conditions.join(' AND ')}
				 ORDER BY id DESC LIMIT ?`
			)
			.bind(...values)
			.all<Block>();
		return results;
	}

	async create(input: CreateBlockInput): Promise<Block> {
		const now = new Date().toISOString();
		const id = generateUlid();
		const block: Block = {
			id,
			account_id: input.account_id,
			target_account_id: input.target_account_id,
			uri: input.uri ?? null,
			created_at: now,
		};

		await this.db
			.prepare(
				'INSERT INTO blocks (id, account_id, target_account_id, uri, created_at) VALUES (?, ?, ?, ?, ?)'
			)
			.bind(block.id, block.account_id, block.target_account_id, block.uri, block.created_at)
			.run();

		return block;
	}

	async delete(id: string): Promise<void> {
		await this.db
			.prepare('DELETE FROM blocks WHERE id = ?')
			.bind(id)
			.run();
	}

	async isBlocked(accountId: string, targetId: string): Promise<boolean> {
		const result = await this.db
			.prepare('SELECT 1 FROM blocks WHERE account_id = ? AND target_account_id = ? LIMIT 1')
			.bind(accountId, targetId)
			.first();
		return result !== null;
	}
}
