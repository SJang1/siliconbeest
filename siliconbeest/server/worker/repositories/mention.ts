import { generateUlid } from '../utils/ulid';

export type Mention = {
	id: string;
	status_id: string;
	account_id: string;
	silent: number;
	created_at: string;
};

export type CreateMentionInput = {
	status_id: string;
	account_id: string;
	silent?: number;
};

export const findByStatusId = async (
	db: D1Database,
	statusId: string,
): Promise<Mention[]> => {
	const { results } = await db
		.prepare('SELECT * FROM mentions WHERE status_id = ? ORDER BY created_at ASC')
		.bind(statusId)
		.all<Mention>();
	return results;
};

export const findByAccountId = async (
	db: D1Database,
	accountId: string,
	limit: number = 20,
	maxId?: string,
): Promise<Mention[]> => {
	const clauses = [
		{ sql: 'account_id = ?', param: accountId },
		...(maxId ? [{ sql: 'id < ?', param: maxId }] : []),
	];
	const where = clauses.map(c => c.sql).join(' AND ');
	const params = [...clauses.map(c => c.param), limit];

	const { results } = await db
		.prepare(
			`SELECT * FROM mentions
			 WHERE ${where}
			 ORDER BY id DESC LIMIT ?`
		)
		.bind(...params)
		.all<Mention>();
	return results;
};

export const create = async (
	db: D1Database,
	input: CreateMentionInput,
): Promise<Mention> => {
	const now = new Date().toISOString();
	const id = generateUlid();
	const mention: Mention = {
		id,
		status_id: input.status_id,
		account_id: input.account_id,
		silent: input.silent ?? 0,
		created_at: now,
	};

	await db
		.prepare(
			'INSERT OR IGNORE INTO mentions (id, status_id, account_id, silent, created_at) VALUES (?, ?, ?, ?, ?)'
		)
		.bind(mention.id, mention.status_id, mention.account_id, mention.silent, mention.created_at)
		.run();

	return mention;
};

export const createBatch = async (
	db: D1Database,
	mentions: CreateMentionInput[],
): Promise<void> => {
	if (mentions.length === 0) return;
	const now = new Date().toISOString();

	const stmts = mentions.map((input) => {
		const id = generateUlid();
		return db
			.prepare(
				'INSERT OR IGNORE INTO mentions (id, status_id, account_id, silent, created_at) VALUES (?, ?, ?, ?, ?)'
			)
			.bind(id, input.status_id, input.account_id, input.silent ?? 0, now);
	});

	await db.batch(stmts);
};
