import { generateUlid } from '../utils/ulid';
import type { NotificationRow } from '../types/db';

/**
 * Notification service: listing, creating, dismissing, and
 * clearing notifications with cursor-based pagination.
 */
export class NotificationService {
	constructor(private db: D1Database) {}

	// ----------------------------------------------------------------
	// List notifications
	// ----------------------------------------------------------------
	async list(
		accountId: string,
		opts: {
			limit?: number;
			maxId?: string;
			sinceId?: string;
			minId?: string;
			types?: string[];
			excludeTypes?: string[];
		},
	): Promise<NotificationRow[]> {
		const limit = Math.min(opts.limit || 15, 30);
		const conditions: string[] = ['n.account_id = ?'];
		const params: (string | number)[] = [accountId];

		if (opts.maxId) {
			conditions.push('n.id < ?');
			params.push(opts.maxId);
		}
		if (opts.sinceId) {
			conditions.push('n.id > ?');
			params.push(opts.sinceId);
		}
		if (opts.minId) {
			conditions.push('n.id > ?');
			params.push(opts.minId);
		}

		if (opts.types && opts.types.length > 0) {
			const placeholders = opts.types.map(() => '?').join(', ');
			conditions.push(`n.type IN (${placeholders})`);
			params.push(...opts.types);
		}

		if (opts.excludeTypes && opts.excludeTypes.length > 0) {
			const placeholders = opts.excludeTypes.map(() => '?').join(', ');
			conditions.push(`n.type NOT IN (${placeholders})`);
			params.push(...opts.excludeTypes);
		}

		params.push(limit);

		const orderDirection = opts.minId ? 'ASC' : 'DESC';

		const query = `
			SELECT n.* FROM notifications n
			WHERE ${conditions.join(' AND ')}
			ORDER BY n.id ${orderDirection}
			LIMIT ?
		`;

		const result = await this.db
			.prepare(query)
			.bind(...params)
			.all();

		const rows = (result.results || []) as unknown as NotificationRow[];
		if (opts.minId) {
			rows.reverse();
		}

		return rows;
	}

	// ----------------------------------------------------------------
	// Get by ID
	// ----------------------------------------------------------------
	async getById(id: string, accountId: string): Promise<NotificationRow | null> {
		return (await this.db
			.prepare('SELECT * FROM notifications WHERE id = ? AND account_id = ? LIMIT 1')
			.bind(id, accountId)
			.first()) as NotificationRow | null;
	}

	// ----------------------------------------------------------------
	// Dismiss a single notification
	// ----------------------------------------------------------------
	async dismiss(id: string, accountId: string): Promise<void> {
		await this.db
			.prepare('DELETE FROM notifications WHERE id = ? AND account_id = ?')
			.bind(id, accountId)
			.run();
	}

	// ----------------------------------------------------------------
	// Clear all notifications for an account
	// ----------------------------------------------------------------
	async clearAll(accountId: string): Promise<void> {
		await this.db
			.prepare('DELETE FROM notifications WHERE account_id = ?')
			.bind(accountId)
			.run();
	}

	// ----------------------------------------------------------------
	// Get unread count
	// ----------------------------------------------------------------
	async getUnreadCount(accountId: string): Promise<number> {
		const result = await this.db
			.prepare('SELECT COUNT(*) AS count FROM notifications WHERE account_id = ? AND read = 0')
			.bind(accountId)
			.first();

		return (result?.count as number) || 0;
	}

	// ----------------------------------------------------------------
	// Create a notification
	// ----------------------------------------------------------------
	async create(
		accountId: string,
		fromAccountId: string,
		type: string,
		statusId?: string,
	): Promise<NotificationRow> {
		// Don't notify yourself
		if (accountId === fromAccountId) {
			throw new Error('Cannot create notification for yourself');
		}

		// Check for duplicate: same type, from same account, for same status
		const existing = await this.db
			.prepare(
				`SELECT id FROM notifications
				WHERE account_id = ? AND from_account_id = ? AND type = ?
				AND (status_id = ? OR (status_id IS NULL AND ? IS NULL))
				LIMIT 1`,
			)
			.bind(accountId, fromAccountId, type, statusId || null, statusId || null)
			.first();

		if (existing) {
			return (await this.getById(existing.id as string, accountId))!;
		}

		// Check if target has muted the source
		const muted = await this.db
			.prepare(
				'SELECT hide_notifications FROM mutes WHERE account_id = ? AND target_account_id = ? LIMIT 1',
			)
			.bind(accountId, fromAccountId)
			.first();

		if (muted && muted.hide_notifications) {
			throw new Error('Notifications muted');
		}

		// Check if target has blocked the source
		const blocked = await this.db
			.prepare(
				'SELECT id FROM blocks WHERE account_id = ? AND target_account_id = ? LIMIT 1',
			)
			.bind(accountId, fromAccountId)
			.first();

		if (blocked) {
			throw new Error('Account blocked');
		}

		const id = generateUlid();
		const now = new Date().toISOString();

		await this.db
			.prepare(
				`INSERT INTO notifications (id, account_id, from_account_id, type, status_id, read, created_at)
				VALUES (?, ?, ?, ?, ?, 0, ?)`,
			)
			.bind(id, accountId, fromAccountId, type, statusId || null, now)
			.run();

		return (await this.getById(id, accountId))!;
	}
}
