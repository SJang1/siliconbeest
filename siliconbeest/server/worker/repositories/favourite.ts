import { env } from 'cloudflare:workers';
import { generateUlid } from '../utils/ulid';

export type Favourite = {
	id: string;
	account_id: string;
	status_id: string;
	uri: string | null;
	created_at: string;
};

export type CreateFavouriteInput = {
	account_id: string;
	status_id: string;
	uri?: string | null;
};

export const findByAccountAndStatus = async (
	accountId: string,
	statusId: string,
): Promise<Favourite | null> => {
	const result = await env.DB
		.prepare('SELECT * FROM favourites WHERE account_id = ? AND status_id = ?')
		.bind(accountId, statusId)
		.first<Favourite>();
	return result ?? null;
};

export const findByAccount = async (
	accountId: string,
	limit: number = 20,
	maxId?: string,
): Promise<Favourite[]> => {
	const clauses = [
		{ sql: 'account_id = ?', param: accountId },
		...(maxId ? [{ sql: 'id < ?', param: maxId }] : []),
	];
	const where = clauses.map(c => c.sql).join(' AND ');
	const params = [...clauses.map(c => c.param), limit];

	const { results } = await env.DB
		.prepare(
			`SELECT * FROM favourites
			 WHERE ${where}
			 ORDER BY id DESC LIMIT ?`
		)
		.bind(...params)
		.all<Favourite>();
	return results;
};

export const findByStatus = async (
	statusId: string,
	limit: number = 20,
	maxId?: string,
): Promise<Favourite[]> => {
	const clauses = [
		{ sql: 'status_id = ?', param: statusId },
		...(maxId ? [{ sql: 'id < ?', param: maxId }] : []),
	];
	const where = clauses.map(c => c.sql).join(' AND ');
	const params = [...clauses.map(c => c.param), limit];

	const { results } = await env.DB
		.prepare(
			`SELECT * FROM favourites
			 WHERE ${where}
			 ORDER BY id DESC LIMIT ?`
		)
		.bind(...params)
		.all<Favourite>();
	return results;
};

export const create = async (
	input: CreateFavouriteInput,
): Promise<Favourite> => {
	const now = new Date().toISOString();
	const id = generateUlid();
	const favourite: Favourite = {
		id,
		account_id: input.account_id,
		status_id: input.status_id,
		uri: input.uri ?? null,
		created_at: now,
	};

	await env.DB
		.prepare(
			'INSERT INTO favourites (id, account_id, status_id, uri, created_at) VALUES (?, ?, ?, ?, ?)'
		)
		.bind(favourite.id, favourite.account_id, favourite.status_id, favourite.uri, favourite.created_at)
		.run();

	return favourite;
};

export const deleteById = async (
	id: string,
): Promise<void> => {
	await env.DB
		.prepare('DELETE FROM favourites WHERE id = ?')
		.bind(id)
		.run();
};

/**
 * Find a favourite by its ActivityPub URI.
 * Used by Undo(Like) processing.
 */
export const findByUri = async (
	uri: string,
): Promise<Favourite | null> => {
	const result = await env.DB
		.prepare('SELECT * FROM favourites WHERE uri = ?')
		.bind(uri)
		.first<Favourite>();
	return result ?? null;
};

/**
 * Delete a favourite by account and status IDs.
 * Used by Undo(Like) processing when URI lookup fails.
 */
export const deleteByAccountAndStatus = async (
	accountId: string,
	statusId: string,
): Promise<void> => {
	await env.DB
		.prepare('DELETE FROM favourites WHERE account_id = ? AND status_id = ?')
		.bind(accountId, statusId)
		.run();
};

export const countByStatus = async (
	statusId: string,
): Promise<number> => {
	const result = await env.DB
		.prepare('SELECT COUNT(*) as count FROM favourites WHERE status_id = ?')
		.bind(statusId)
		.first<{ count: number }>();
	return result?.count ?? 0;
};
