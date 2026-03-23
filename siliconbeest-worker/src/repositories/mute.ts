import { generateUlid } from '../utils/ulid';

export interface Mute {
	id: string;
	account_id: string;
	target_account_id: string;
	hide_notifications: number;
	expires_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface CreateMuteInput {
	account_id: string;
	target_account_id: string;
	hide_notifications?: number;
	expires_at?: string | null;
}

export class MuteRepository {
	constructor(private db: D1Database) {}

	async findByAccountAndTarget(accountId: string, targetAccountId: string): Promise<Mute | null> {
		const result = await this.db
			.prepare('SELECT * FROM mutes WHERE account_id = ? AND target_account_id = ?')
			.bind(accountId, targetAccountId)
			.first<Mute>();
		return result ?? null;
	}

	async findByAccount(accountId: string, limit: number = 40, maxId?: string): Promise<Mute[]> {
		const conditions: string[] = ['account_id = ?'];
		const values: unknown[] = [accountId];

		if (maxId) {
			conditions.push('id < ?');
			values.push(maxId);
		}

		values.push(limit);

		const { results } = await this.db
			.prepare(
				`SELECT * FROM mutes
				 WHERE ${conditions.join(' AND ')}
				 ORDER BY id DESC LIMIT ?`
			)
			.bind(...values)
			.all<Mute>();
		return results;
	}

	async create(input: CreateMuteInput): Promise<Mute> {
		const now = new Date().toISOString();
		const id = generateUlid();
		const mute: Mute = {
			id,
			account_id: input.account_id,
			target_account_id: input.target_account_id,
			hide_notifications: input.hide_notifications ?? 1,
			expires_at: input.expires_at ?? null,
			created_at: now,
			updated_at: now,
		};

		await this.db
			.prepare(
				`INSERT INTO mutes (id, account_id, target_account_id, hide_notifications, expires_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				mute.id, mute.account_id, mute.target_account_id,
				mute.hide_notifications, mute.expires_at,
				mute.created_at, mute.updated_at
			)
			.run();

		return mute;
	}

	async delete(id: string): Promise<void> {
		await this.db
			.prepare('DELETE FROM mutes WHERE id = ?')
			.bind(id)
			.run();
	}

	async isMuted(accountId: string, targetId: string): Promise<boolean> {
		const result = await this.db
			.prepare(
				`SELECT 1 FROM mutes
				 WHERE account_id = ? AND target_account_id = ?
				 AND (expires_at IS NULL OR expires_at > ?)
				 LIMIT 1`
			)
			.bind(accountId, targetId, new Date().toISOString())
			.first();
		return result !== null;
	}
}
