import { env } from 'cloudflare:workers';
import { generateUlid } from '../utils/ulid';

export type Notification = {
	id: string;
	account_id: string;
	from_account_id: string;
	type: string;
	status_id: string | null;
	read: number;
	created_at: string;
};

export type CreateNotificationInput = {
	account_id: string;
	from_account_id: string;
	type: string;
	status_id?: string | null;
};

export type NotificationQueryOptions = {
	limit?: number;
	maxId?: string;
	types?: string[];
	excludeTypes?: string[];
};

export const findByAccount = async (accountId: string, opts: NotificationQueryOptions = {}): Promise<Notification[]> => {
	const limit = opts.limit ?? 20;
	const clauses = [
		{ sql: 'account_id = ?', params: [accountId] },
		...(opts.maxId ? [{ sql: 'id < ?', params: [opts.maxId] }] : []),
		...(opts.types && opts.types.length > 0
			? [{ sql: `type IN (${opts.types.map(() => '?').join(', ')})`, params: [...opts.types] }]
			: []),
		...(opts.excludeTypes && opts.excludeTypes.length > 0
			? [{ sql: `type NOT IN (${opts.excludeTypes.map(() => '?').join(', ')})`, params: [...opts.excludeTypes] }]
			: []),
	];
	const where = clauses.map(c => c.sql).join(' AND ');
	const params = [...clauses.flatMap(c => c.params), limit];

	const { results } = await env.DB
		.prepare(
			`SELECT * FROM notifications
			 WHERE ${where}
			 ORDER BY id DESC LIMIT ?`
		)
		.bind(...params)
		.all<Notification>();
	return results;
};

export const findById = async (id: string): Promise<Notification | null> => {
	const result = await env.DB
		.prepare('SELECT * FROM notifications WHERE id = ?')
		.bind(id)
		.first<Notification>();
	return result ?? null;
};

export const create = async (input: CreateNotificationInput): Promise<Notification> => {
	const now = new Date().toISOString();
	const id = generateUlid();
	const notification: Notification = {
		id,
		account_id: input.account_id,
		from_account_id: input.from_account_id,
		type: input.type,
		status_id: input.status_id ?? null,
		read: 0,
		created_at: now,
	};

	await env.DB
		.prepare(
			`INSERT INTO notifications (id, account_id, from_account_id, type, status_id, read, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			notification.id, notification.account_id, notification.from_account_id,
			notification.type, notification.status_id, notification.read,
			notification.created_at
		)
		.run();

	return notification;
};

export const dismiss = async (id: string, accountId: string): Promise<void> => {
	await env.DB
		.prepare('DELETE FROM notifications WHERE id = ? AND account_id = ?')
		.bind(id, accountId)
		.run();
};

export const clearAll = async (accountId: string): Promise<void> => {
	await env.DB
		.prepare('DELETE FROM notifications WHERE account_id = ?')
		.bind(accountId)
		.run();
};

export const countUnread = async (accountId: string): Promise<number> => {
	const result = await env.DB
		.prepare('SELECT COUNT(*) as count FROM notifications WHERE account_id = ? AND read = 0')
		.bind(accountId)
		.first<{ count: number }>();
	return result?.count ?? 0;
};
