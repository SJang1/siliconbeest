import { generateUlid } from '../utils/ulid';

export type Bookmark = {
	id: string;
	account_id: string;
	status_id: string;
	created_at: string;
};

export type CreateBookmarkInput = {
	account_id: string;
	status_id: string;
};

export const findByAccountAndStatus = async (
	db: D1Database,
	accountId: string,
	statusId: string,
): Promise<Bookmark | null> => {
	const result = await db
		.prepare('SELECT * FROM bookmarks WHERE account_id = ? AND status_id = ?')
		.bind(accountId, statusId)
		.first<Bookmark>();
	return result ?? null;
};

export const findByAccount = async (
	db: D1Database,
	accountId: string,
	limit: number = 20,
	maxId?: string,
): Promise<Bookmark[]> => {
	const clauses = [
		{ sql: 'account_id = ?', param: accountId },
		...(maxId ? [{ sql: 'id < ?', param: maxId }] : []),
	];
	const where = clauses.map(c => c.sql).join(' AND ');
	const params = [...clauses.map(c => c.param), limit];

	const { results } = await db
		.prepare(
			`SELECT * FROM bookmarks
			 WHERE ${where}
			 ORDER BY id DESC LIMIT ?`
		)
		.bind(...params)
		.all<Bookmark>();
	return results;
};

export const create = async (
	db: D1Database,
	input: CreateBookmarkInput,
): Promise<Bookmark> => {
	const now = new Date().toISOString();
	const id = generateUlid();
	const bookmark: Bookmark = {
		id,
		account_id: input.account_id,
		status_id: input.status_id,
		created_at: now,
	};

	await db
		.prepare(
			'INSERT INTO bookmarks (id, account_id, status_id, created_at) VALUES (?, ?, ?, ?)'
		)
		.bind(bookmark.id, bookmark.account_id, bookmark.status_id, bookmark.created_at)
		.run();

	return bookmark;
};

export const deleteById = async (
	db: D1Database,
	id: string,
): Promise<void> => {
	await db
		.prepare('DELETE FROM bookmarks WHERE id = ?')
		.bind(id)
		.run();
};
