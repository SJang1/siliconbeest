import { generateUlid } from '../utils/ulid';

export interface Status {
	id: string;
	uri: string;
	url: string | null;
	account_id: string;
	in_reply_to_id: string | null;
	in_reply_to_account_id: string | null;
	reblog_of_id: string | null;
	text: string;
	content: string;
	content_warning: string;
	visibility: string;
	sensitive: number;
	language: string;
	conversation_id: string | null;
	reply: number;
	replies_count: number;
	reblogs_count: number;
	favourites_count: number;
	local: number;
	federated_at: string | null;
	edited_at: string | null;
	deleted_at: string | null;
	poll_id: string | null;
	created_at: string;
	updated_at: string;
}

export interface CreateStatusInput {
	uri: string;
	account_id: string;
	url?: string | null;
	in_reply_to_id?: string | null;
	in_reply_to_account_id?: string | null;
	reblog_of_id?: string | null;
	text?: string;
	content?: string;
	content_warning?: string;
	visibility?: string;
	sensitive?: number;
	language?: string;
	conversation_id?: string | null;
	reply?: number;
	local?: number;
	poll_id?: string | null;
}

export interface TimelineOptions {
	limit?: number;
	maxId?: string;
	sinceId?: string;
	minId?: string;
}

export interface AccountStatusOptions {
	limit?: number;
	maxId?: string;
	excludeReplies?: boolean;
	excludeReblogs?: boolean;
	onlyMedia?: boolean;
}

export class StatusRepository {
	constructor(private db: D1Database) {}

	async findById(id: string): Promise<Status | null> {
		const result = await this.db
			.prepare('SELECT * FROM statuses WHERE id = ? AND deleted_at IS NULL')
			.bind(id)
			.first<Status>();
		return result ?? null;
	}

	async findByUri(uri: string): Promise<Status | null> {
		const result = await this.db
			.prepare('SELECT * FROM statuses WHERE uri = ? AND deleted_at IS NULL')
			.bind(uri)
			.first<Status>();
		return result ?? null;
	}

	async findByAccountId(accountId: string, opts: AccountStatusOptions = {}): Promise<Status[]> {
		const limit = opts.limit ?? 20;
		const conditions: string[] = ['account_id = ?', 'deleted_at IS NULL'];
		const values: unknown[] = [accountId];

		if (opts.maxId) {
			conditions.push('id < ?');
			values.push(opts.maxId);
		}
		if (opts.excludeReplies) {
			conditions.push('reply = 0');
		}
		if (opts.excludeReblogs) {
			conditions.push('reblog_of_id IS NULL');
		}
		if (opts.onlyMedia) {
			conditions.push(
				'id IN (SELECT status_id FROM media_attachments WHERE status_id IS NOT NULL)'
			);
		}

		values.push(limit);

		const { results } = await this.db
			.prepare(
				`SELECT * FROM statuses
				 WHERE ${conditions.join(' AND ')}
				 ORDER BY id DESC LIMIT ?`
			)
			.bind(...values)
			.all<Status>();
		return results;
	}

	async create(input: CreateStatusInput): Promise<Status> {
		const now = new Date().toISOString();
		const id = generateUlid();
		const status: Status = {
			id,
			uri: input.uri,
			url: input.url ?? null,
			account_id: input.account_id,
			in_reply_to_id: input.in_reply_to_id ?? null,
			in_reply_to_account_id: input.in_reply_to_account_id ?? null,
			reblog_of_id: input.reblog_of_id ?? null,
			text: input.text ?? '',
			content: input.content ?? '',
			content_warning: input.content_warning ?? '',
			visibility: input.visibility ?? 'public',
			sensitive: input.sensitive ?? 0,
			language: input.language ?? 'en',
			conversation_id: input.conversation_id ?? null,
			reply: input.reply ?? 0,
			replies_count: 0,
			reblogs_count: 0,
			favourites_count: 0,
			local: input.local ?? 1,
			federated_at: null,
			edited_at: null,
			deleted_at: null,
			poll_id: input.poll_id ?? null,
			created_at: now,
			updated_at: now,
		};

		await this.db
			.prepare(
				`INSERT INTO statuses (
					id, uri, url, account_id,
					in_reply_to_id, in_reply_to_account_id, reblog_of_id,
					text, content, content_warning, visibility,
					sensitive, language, conversation_id, reply,
					replies_count, reblogs_count, favourites_count,
					local, federated_at, edited_at, deleted_at, poll_id,
					created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				status.id, status.uri, status.url, status.account_id,
				status.in_reply_to_id, status.in_reply_to_account_id, status.reblog_of_id,
				status.text, status.content, status.content_warning, status.visibility,
				status.sensitive, status.language, status.conversation_id, status.reply,
				status.replies_count, status.reblogs_count, status.favourites_count,
				status.local, status.federated_at, status.edited_at, status.deleted_at,
				status.poll_id, status.created_at, status.updated_at
			)
			.run();

		return status;
	}

	async update(
		id: string,
		input: Partial<Omit<Status, 'id' | 'created_at' | 'updated_at'>>
	): Promise<Status | null> {
		const now = new Date().toISOString();
		const fields: string[] = [];
		const values: unknown[] = [];

		for (const [key, value] of Object.entries(input)) {
			fields.push(`${key} = ?`);
			values.push(value);
		}

		fields.push('updated_at = ?');
		values.push(now);
		values.push(id);

		await this.db
			.prepare(`UPDATE statuses SET ${fields.join(', ')} WHERE id = ?`)
			.bind(...values)
			.run();

		return this.findById(id);
	}

	async delete(id: string): Promise<void> {
		const now = new Date().toISOString();
		await this.db
			.prepare('UPDATE statuses SET deleted_at = ?, updated_at = ? WHERE id = ?')
			.bind(now, now, id)
			.run();
	}

	async updateCounts(
		id: string,
		counts: { replies_count?: number; reblogs_count?: number; favourites_count?: number }
	): Promise<void> {
		const fields: string[] = [];
		const values: unknown[] = [];

		if (counts.replies_count !== undefined) {
			fields.push('replies_count = ?');
			values.push(counts.replies_count);
		}
		if (counts.reblogs_count !== undefined) {
			fields.push('reblogs_count = ?');
			values.push(counts.reblogs_count);
		}
		if (counts.favourites_count !== undefined) {
			fields.push('favourites_count = ?');
			values.push(counts.favourites_count);
		}

		if (fields.length === 0) return;

		fields.push('updated_at = ?');
		values.push(new Date().toISOString());
		values.push(id);

		await this.db
			.prepare(`UPDATE statuses SET ${fields.join(', ')} WHERE id = ?`)
			.bind(...values)
			.run();
	}

	/**
	 * Increment a count field atomically. Used by federation inbox processors
	 * (like, announce, create) to update counts without race conditions.
	 */
	async incrementCount(id: string, field: 'replies_count' | 'reblogs_count' | 'favourites_count'): Promise<void> {
		await this.db
			.prepare(`UPDATE statuses SET ${field} = ${field} + 1, updated_at = ? WHERE id = ?`)
			.bind(new Date().toISOString(), id)
			.run();
	}

	/**
	 * Decrement a count field atomically, flooring at 0.
	 */
	async decrementCount(id: string, field: 'replies_count' | 'reblogs_count' | 'favourites_count'): Promise<void> {
		await this.db
			.prepare(`UPDATE statuses SET ${field} = MAX(0, ${field} - 1), updated_at = ? WHERE id = ?`)
			.bind(new Date().toISOString(), id)
			.run();
	}

	/**
	 * Soft-delete all statuses by account (used when deleting remote actors).
	 */
	async softDeleteByAccount(accountId: string): Promise<void> {
		const now = new Date().toISOString();
		await this.db
			.prepare('UPDATE statuses SET deleted_at = ?, updated_at = ? WHERE account_id = ? AND deleted_at IS NULL')
			.bind(now, now, accountId)
			.run();
	}

	/**
	 * Find a status by URI including deleted statuses (for processing Delete activities).
	 */
	async findByUriIncludeDeleted(uri: string): Promise<Status | null> {
		const result = await this.db
			.prepare('SELECT * FROM statuses WHERE uri = ?')
			.bind(uri)
			.first<Status>();
		return result ?? null;
	}

	/**
	 * Find a status with its parent info (for reply threading).
	 */
	async findWithParent(id: string): Promise<(Status & { parent_account_id?: string }) | null> {
		const result = await this.db
			.prepare(
				`SELECT s.*, ps.account_id as parent_account_id
				 FROM statuses s
				 LEFT JOIN statuses ps ON ps.id = s.in_reply_to_id
				 WHERE s.id = ? AND s.deleted_at IS NULL`
			)
			.bind(id)
			.first<Status & { parent_account_id?: string }>();
		return result ?? null;
	}

	async findContext(statusId: string): Promise<{ ancestors: Status[]; descendants: Status[] }> {
		// Find ancestors by walking up in_reply_to_id chain
		const ancestors: Status[] = [];
		let currentId: string | null = statusId;

		while (currentId) {
			const parent: Status | null = await this.db
				.prepare(
					'SELECT * FROM statuses WHERE id = (SELECT in_reply_to_id FROM statuses WHERE id = ? AND deleted_at IS NULL) AND deleted_at IS NULL'
				)
				.bind(currentId)
				.first<Status>();

			if (!parent) break;
			ancestors.unshift(parent);
			currentId = parent.in_reply_to_id;
		}

		// Find descendants recursively (direct replies and their replies)
		const { results: descendants } = await this.db
			.prepare(
				`WITH RECURSIVE thread AS (
					SELECT * FROM statuses WHERE in_reply_to_id = ? AND deleted_at IS NULL
					UNION ALL
					SELECT s.* FROM statuses s
					JOIN thread t ON s.in_reply_to_id = t.id
					WHERE s.deleted_at IS NULL
				)
				SELECT * FROM thread ORDER BY id ASC`
			)
			.bind(statusId)
			.all<Status>();

		return { ancestors, descendants };
	}

	async findPublicTimeline(opts: TimelineOptions = {}): Promise<Status[]> {
		const limit = opts.limit ?? 20;
		const conditions: string[] = [
			'deleted_at IS NULL',
			"visibility = 'public'",
			'reblog_of_id IS NULL',
		];
		const values: unknown[] = [];

		if (opts.maxId) {
			conditions.push('id < ?');
			values.push(opts.maxId);
		}
		if (opts.sinceId) {
			conditions.push('id > ?');
			values.push(opts.sinceId);
		}
		if (opts.minId) {
			conditions.push('id > ?');
			values.push(opts.minId);
		}

		values.push(limit);

		const { results } = await this.db
			.prepare(
				`SELECT * FROM statuses
				 WHERE ${conditions.join(' AND ')}
				 ORDER BY id DESC LIMIT ?`
			)
			.bind(...values)
			.all<Status>();
		return results;
	}

	async findLocalTimeline(opts: TimelineOptions = {}): Promise<Status[]> {
		const limit = opts.limit ?? 20;
		const conditions: string[] = [
			'deleted_at IS NULL',
			"visibility = 'public'",
			'local = 1',
			'reblog_of_id IS NULL',
		];
		const values: unknown[] = [];

		if (opts.maxId) {
			conditions.push('id < ?');
			values.push(opts.maxId);
		}
		if (opts.sinceId) {
			conditions.push('id > ?');
			values.push(opts.sinceId);
		}
		if (opts.minId) {
			conditions.push('id > ?');
			values.push(opts.minId);
		}

		values.push(limit);

		const { results } = await this.db
			.prepare(
				`SELECT * FROM statuses
				 WHERE ${conditions.join(' AND ')}
				 ORDER BY id DESC LIMIT ?`
			)
			.bind(...values)
			.all<Status>();
		return results;
	}

	async findByTag(tag: string, opts: TimelineOptions = {}): Promise<Status[]> {
		const limit = opts.limit ?? 20;
		const conditions: string[] = [
			's.deleted_at IS NULL',
			"s.visibility = 'public'",
		];
		const values: unknown[] = [tag.toLowerCase()];

		if (opts.maxId) {
			conditions.push('s.id < ?');
			values.push(opts.maxId);
		}
		if (opts.sinceId) {
			conditions.push('s.id > ?');
			values.push(opts.sinceId);
		}

		values.push(limit);

		const { results } = await this.db
			.prepare(
				`SELECT s.* FROM statuses s
				 JOIN status_tags st ON st.status_id = s.id
				 JOIN tags t ON t.id = st.tag_id
				 WHERE t.name = ? AND ${conditions.join(' AND ')}
				 ORDER BY s.id DESC LIMIT ?`
			)
			.bind(...values)
			.all<Status>();
		return results;
	}
}
