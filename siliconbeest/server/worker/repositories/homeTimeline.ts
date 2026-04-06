import { env } from 'cloudflare:workers';
import { generateUlid } from '../utils/ulid';

export type HomeTimelineEntry = {
	id: string;
	account_id: string;
	status_id: string;
	created_at: string;
};

export const findByAccount = async (
	accountId: string,
	limit: number = 20,
	maxId?: string,
	sinceId?: string,
): Promise<HomeTimelineEntry[]> => {
	const clauses = [
		{ sql: 'account_id = ?', param: accountId },
		...(maxId ? [{ sql: 'id < ?', param: maxId }] : []),
		...(sinceId ? [{ sql: 'id > ?', param: sinceId }] : []),
	];
	const where = clauses.map(c => c.sql).join(' AND ');
	const params = [...clauses.map(c => c.param), limit];

	const { results } = await env.DB
		.prepare(
			`SELECT * FROM home_timeline_entries
			 WHERE ${where}
			 ORDER BY id DESC LIMIT ?`
		)
		.bind(...params)
		.all<HomeTimelineEntry>();
	return results;
};

export const insert = async (
	accountId: string,
	statusId: string,
): Promise<HomeTimelineEntry> => {
	const now = new Date().toISOString();
	const id = generateUlid();
	const entry: HomeTimelineEntry = {
		id,
		account_id: accountId,
		status_id: statusId,
		created_at: now,
	};

	await env.DB
		.prepare(
			`INSERT OR IGNORE INTO home_timeline_entries (id, account_id, status_id, created_at)
			 VALUES (?, ?, ?, ?)`
		)
		.bind(entry.id, entry.account_id, entry.status_id, entry.created_at)
		.run();

	return entry;
};

export const insertBatch = async (
	accountId: string,
	statusIds: string[],
): Promise<void> => {
	if (statusIds.length === 0) return;
	const now = new Date().toISOString();

	const stmts = statusIds.map((statusId) => {
		const id = generateUlid();
		return env.DB
			.prepare(
				`INSERT OR IGNORE INTO home_timeline_entries (id, account_id, status_id, created_at)
				 VALUES (?, ?, ?, ?)`
			)
			.bind(id, accountId, statusId, now);
	});

	await env.DB.batch(stmts);
};

export const deleteByStatus = async (
	statusId: string,
): Promise<void> => {
	await env.DB
		.prepare('DELETE FROM home_timeline_entries WHERE status_id = ?')
		.bind(statusId)
		.run();
};

export const deleteByAccount = async (
	accountId: string,
): Promise<void> => {
	await env.DB
		.prepare('DELETE FROM home_timeline_entries WHERE account_id = ?')
		.bind(accountId)
		.run();
};
