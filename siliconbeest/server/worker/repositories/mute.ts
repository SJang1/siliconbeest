import { generateUlid } from '../utils/ulid';

export type Mute = {
	id: string;
	account_id: string;
	target_account_id: string;
	hide_notifications: number;
	expires_at: string | null;
	created_at: string;
	updated_at: string;
};

export type CreateMuteInput = {
	account_id: string;
	target_account_id: string;
	hide_notifications?: number;
	expires_at?: string | null;
};

export const findByAccountAndTarget = async (
	db: D1Database,
	accountId: string,
	targetAccountId: string,
): Promise<Mute | null> => {
	const result = await db
		.prepare('SELECT * FROM mutes WHERE account_id = ? AND target_account_id = ?')
		.bind(accountId, targetAccountId)
		.first<Mute>();
	return result ?? null;
};

export const findByAccount = async (
	db: D1Database,
	accountId: string,
	limit: number = 40,
	maxId?: string,
): Promise<Mute[]> => {
	const clauses = [
		{ sql: 'account_id = ?', param: accountId },
		...(maxId ? [{ sql: 'id < ?', param: maxId }] : []),
	];
	const where = clauses.map(c => c.sql).join(' AND ');
	const params = [...clauses.map(c => c.param), limit];

	const { results } = await db
		.prepare(
			`SELECT * FROM mutes
			 WHERE ${where}
			 ORDER BY id DESC LIMIT ?`
		)
		.bind(...params)
		.all<Mute>();
	return results;
};

export const create = async (
	db: D1Database,
	input: CreateMuteInput,
): Promise<Mute> => {
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

	await db
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
};

export const deleteById = async (
	db: D1Database,
	id: string,
): Promise<void> => {
	await db
		.prepare('DELETE FROM mutes WHERE id = ?')
		.bind(id)
		.run();
};

export const isMuted = async (
	db: D1Database,
	accountId: string,
	targetId: string,
): Promise<boolean> => {
	const result = await db
		.prepare(
			`SELECT 1 FROM mutes
			 WHERE account_id = ? AND target_account_id = ?
			 AND (expires_at IS NULL OR expires_at > ?)
			 LIMIT 1`
		)
		.bind(accountId, targetId, new Date().toISOString())
		.first();
	return result !== null;
};
