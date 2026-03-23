import { generateUlid } from '../utils/ulid';

export interface Notification {
	id: string;
	account_id: string;
	from_account_id: string;
	type: string;
	status_id: string | null;
	read: number;
	created_at: string;
}

export interface CreateNotificationInput {
	account_id: string;
	from_account_id: string;
	type: string;
	status_id?: string | null;
}

export interface NotificationQueryOptions {
	limit?: number;
	maxId?: string;
	types?: string[];
	excludeTypes?: string[];
}

export class NotificationRepository {
	constructor(private db: D1Database) {}

	async findByAccount(accountId: string, opts: NotificationQueryOptions = {}): Promise<Notification[]> {
		const limit = opts.limit ?? 20;
		const conditions: string[] = ['account_id = ?'];
		const values: unknown[] = [accountId];

		if (opts.maxId) {
			conditions.push('id < ?');
			values.push(opts.maxId);
		}
		if (opts.types && opts.types.length > 0) {
			const placeholders = opts.types.map(() => '?').join(', ');
			conditions.push(`type IN (${placeholders})`);
			values.push(...opts.types);
		}
		if (opts.excludeTypes && opts.excludeTypes.length > 0) {
			const placeholders = opts.excludeTypes.map(() => '?').join(', ');
			conditions.push(`type NOT IN (${placeholders})`);
			values.push(...opts.excludeTypes);
		}

		values.push(limit);

		const { results } = await this.db
			.prepare(
				`SELECT * FROM notifications
				 WHERE ${conditions.join(' AND ')}
				 ORDER BY id DESC LIMIT ?`
			)
			.bind(...values)
			.all<Notification>();
		return results;
	}

	async findById(id: string): Promise<Notification | null> {
		const result = await this.db
			.prepare('SELECT * FROM notifications WHERE id = ?')
			.bind(id)
			.first<Notification>();
		return result ?? null;
	}

	async create(input: CreateNotificationInput): Promise<Notification> {
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

		await this.db
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
	}

	async dismiss(id: string, accountId: string): Promise<void> {
		await this.db
			.prepare('DELETE FROM notifications WHERE id = ? AND account_id = ?')
			.bind(id, accountId)
			.run();
	}

	async clearAll(accountId: string): Promise<void> {
		await this.db
			.prepare('DELETE FROM notifications WHERE account_id = ?')
			.bind(accountId)
			.run();
	}

	async countUnread(accountId: string): Promise<number> {
		const result = await this.db
			.prepare('SELECT COUNT(*) as count FROM notifications WHERE account_id = ? AND read = 0')
			.bind(accountId)
			.first<{ count: number }>();
		return result?.count ?? 0;
	}
}
