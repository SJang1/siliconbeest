import { env } from 'cloudflare:workers';
import { generateUlid } from '../utils/ulid';

export type Block = {
	id: string;
	account_id: string;
	target_account_id: string;
	uri: string | null;
	created_at: string;
};

export type CreateBlockInput = {
	account_id: string;
	target_account_id: string;
	uri?: string | null;
};

export const findByAccountAndTarget = async (
	accountId: string,
	targetAccountId: string,
): Promise<Block | null> => {
	const result = await env.DB
		.prepare('SELECT * FROM blocks WHERE account_id = ? AND target_account_id = ?')
		.bind(accountId, targetAccountId)
		.first<Block>();
	return result ?? null;
};

export const findByAccount = async (
	accountId: string,
	limit: number = 40,
	maxId?: string,
): Promise<Block[]> => {
	const clauses = [
		{ sql: 'account_id = ?', param: accountId },
		...(maxId ? [{ sql: 'id < ?', param: maxId }] : []),
	];
	const where = clauses.map(c => c.sql).join(' AND ');
	const params = [...clauses.map(c => c.param), limit];

	const { results } = await env.DB
		.prepare(
			`SELECT * FROM blocks
			 WHERE ${where}
			 ORDER BY id DESC LIMIT ?`
		)
		.bind(...params)
		.all<Block>();
	return results;
};

export const create = async (
	input: CreateBlockInput,
): Promise<Block> => {
	const now = new Date().toISOString();
	const id = generateUlid();
	const block: Block = {
		id,
		account_id: input.account_id,
		target_account_id: input.target_account_id,
		uri: input.uri ?? null,
		created_at: now,
	};

	await env.DB
		.prepare(
			'INSERT INTO blocks (id, account_id, target_account_id, uri, created_at) VALUES (?, ?, ?, ?, ?)'
		)
		.bind(block.id, block.account_id, block.target_account_id, block.uri, block.created_at)
		.run();

	return block;
};

export const deleteById = async (
	id: string,
): Promise<void> => {
	await env.DB
		.prepare('DELETE FROM blocks WHERE id = ?')
		.bind(id)
		.run();
};

export const isBlocked = async (
	accountId: string,
	targetId: string,
): Promise<boolean> => {
	const result = await env.DB
		.prepare('SELECT 1 FROM blocks WHERE account_id = ? AND target_account_id = ? LIMIT 1')
		.bind(accountId, targetId)
		.first();
	return result !== null;
};
