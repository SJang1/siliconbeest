import type { StatusRow } from '../types/db';

/**
 * Timeline service: home, public, tag, and list timelines
 * with cursor-based pagination (max_id / since_id / min_id).
 */
export class TimelineService {
	constructor(private db: D1Database) {}

	// ----------------------------------------------------------------
	// Home timeline (from home_timeline_entries)
	// ----------------------------------------------------------------
	async getHome(
		accountId: string,
		opts: { limit?: number; maxId?: string; sinceId?: string; minId?: string },
	): Promise<StatusRow[]> {
		const limit = Math.min(opts.limit || 20, 40);
		const conditions: string[] = ['hte.account_id = ?'];
		const params: (string | number)[] = [accountId];

		conditions.push('s.deleted_at IS NULL');

		if (opts.maxId) {
			conditions.push('hte.status_id < ?');
			params.push(opts.maxId);
		}
		if (opts.sinceId) {
			conditions.push('hte.status_id > ?');
			params.push(opts.sinceId);
		}
		if (opts.minId) {
			conditions.push('hte.status_id > ?');
			params.push(opts.minId);
		}

		params.push(limit);

		// When minId is used, we want ascending order then reverse
		const orderDirection = opts.minId ? 'ASC' : 'DESC';

		const query = `
			SELECT s.* FROM statuses s
			INNER JOIN home_timeline_entries hte ON hte.status_id = s.id
			WHERE ${conditions.join(' AND ')}
			ORDER BY hte.status_id ${orderDirection}
			LIMIT ?
		`;

		const result = await this.db
			.prepare(query)
			.bind(...params)
			.all();

		const rows = (result.results || []) as unknown as StatusRow[];

		// If minId was used, reverse to get descending order
		if (opts.minId) {
			rows.reverse();
		}

		return rows;
	}

	// ----------------------------------------------------------------
	// Public timeline
	// ----------------------------------------------------------------
	async getPublic(
		opts: {
			local?: boolean;
			limit?: number;
			maxId?: string;
			sinceId?: string;
			minId?: string;
			onlyMedia?: boolean;
		},
	): Promise<StatusRow[]> {
		const limit = Math.min(opts.limit || 20, 40);
		const conditions: string[] = [
			's.deleted_at IS NULL',
			's.visibility = ?',
			's.reblog_of_id IS NULL',
		];
		const params: (string | number)[] = ['public'];

		if (opts.local) {
			conditions.push('s.local = 1');
		}

		if (opts.onlyMedia) {
			conditions.push('EXISTS (SELECT 1 FROM media_attachments ma WHERE ma.status_id = s.id)');
		}

		if (opts.maxId) {
			conditions.push('s.id < ?');
			params.push(opts.maxId);
		}
		if (opts.sinceId) {
			conditions.push('s.id > ?');
			params.push(opts.sinceId);
		}
		if (opts.minId) {
			conditions.push('s.id > ?');
			params.push(opts.minId);
		}

		params.push(limit);

		const orderDirection = opts.minId ? 'ASC' : 'DESC';

		const query = `
			SELECT s.* FROM statuses s
			WHERE ${conditions.join(' AND ')}
			ORDER BY s.id ${orderDirection}
			LIMIT ?
		`;

		const result = await this.db
			.prepare(query)
			.bind(...params)
			.all();

		const rows = (result.results || []) as unknown as StatusRow[];
		if (opts.minId) {
			rows.reverse();
		}

		return rows;
	}

	// ----------------------------------------------------------------
	// Tag timeline
	// ----------------------------------------------------------------
	async getTag(
		tag: string,
		opts: {
			local?: boolean;
			limit?: number;
			maxId?: string;
			sinceId?: string;
			minId?: string;
		},
	): Promise<StatusRow[]> {
		const limit = Math.min(opts.limit || 20, 40);
		const normalizedTag = tag.toLowerCase();

		const conditions: string[] = [
			's.deleted_at IS NULL',
			"s.visibility IN ('public', 'unlisted')",
			's.reblog_of_id IS NULL',
			't.name = ?',
		];
		const params: (string | number)[] = [normalizedTag];

		if (opts.local) {
			conditions.push('s.local = 1');
		}

		if (opts.maxId) {
			conditions.push('s.id < ?');
			params.push(opts.maxId);
		}
		if (opts.sinceId) {
			conditions.push('s.id > ?');
			params.push(opts.sinceId);
		}
		if (opts.minId) {
			conditions.push('s.id > ?');
			params.push(opts.minId);
		}

		params.push(limit);

		const orderDirection = opts.minId ? 'ASC' : 'DESC';

		const query = `
			SELECT s.* FROM statuses s
			INNER JOIN status_tags st ON st.status_id = s.id
			INNER JOIN tags t ON t.id = st.tag_id
			WHERE ${conditions.join(' AND ')}
			ORDER BY s.id ${orderDirection}
			LIMIT ?
		`;

		const result = await this.db
			.prepare(query)
			.bind(...params)
			.all();

		const rows = (result.results || []) as unknown as StatusRow[];
		if (opts.minId) {
			rows.reverse();
		}

		return rows;
	}

	// ----------------------------------------------------------------
	// List timeline
	// ----------------------------------------------------------------
	async getList(
		listId: string,
		accountId: string,
		opts: { limit?: number; maxId?: string; sinceId?: string; minId?: string },
	): Promise<StatusRow[]> {
		// Verify list ownership
		const list = await this.db
			.prepare('SELECT id FROM lists WHERE id = ? AND account_id = ? LIMIT 1')
			.bind(listId, accountId)
			.first();

		if (!list) {
			throw new Error('List not found');
		}

		const limit = Math.min(opts.limit || 20, 40);
		const conditions: string[] = [
			's.deleted_at IS NULL',
			'la.list_id = ?',
		];
		const params: (string | number)[] = [listId];

		if (opts.maxId) {
			conditions.push('s.id < ?');
			params.push(opts.maxId);
		}
		if (opts.sinceId) {
			conditions.push('s.id > ?');
			params.push(opts.sinceId);
		}
		if (opts.minId) {
			conditions.push('s.id > ?');
			params.push(opts.minId);
		}

		params.push(limit);

		const orderDirection = opts.minId ? 'ASC' : 'DESC';

		const query = `
			SELECT s.* FROM statuses s
			INNER JOIN list_accounts la ON la.account_id = s.account_id
			WHERE ${conditions.join(' AND ')}
			ORDER BY s.id ${orderDirection}
			LIMIT ?
		`;

		const result = await this.db
			.prepare(query)
			.bind(...params)
			.all();

		const rows = (result.results || []) as unknown as StatusRow[];
		if (opts.minId) {
			rows.reverse();
		}

		return rows;
	}
}
