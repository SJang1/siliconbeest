import { env } from 'cloudflare:workers';
import { generateUlid } from '../utils/ulid';

export type Status = {
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
};

export type CreateStatusInput = {
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
};

export type TimelineOptions = {
	limit?: number;
	maxId?: string;
	sinceId?: string;
	minId?: string;
};

export type AccountStatusOptions = {
	limit?: number;
	maxId?: string;
	excludeReplies?: boolean;
	excludeReblogs?: boolean;
	onlyMedia?: boolean;
};

export const findById = async (id: string): Promise<Status | null> => {
	const result = await env.DB
		.prepare('SELECT * FROM statuses WHERE id = ? AND deleted_at IS NULL')
		.bind(id)
		.first<Status>();
	return result ?? null;
};

export const findByUri = async (uri: string): Promise<Status | null> => {
	const result = await env.DB
		.prepare('SELECT * FROM statuses WHERE uri = ? AND deleted_at IS NULL')
		.bind(uri)
		.first<Status>();
	return result ?? null;
};

export const findByAccountId = async (accountId: string, opts: AccountStatusOptions = {}): Promise<Status[]> => {
	const limit = opts.limit ?? 20;
	const clauses = [
		{ sql: 'account_id = ?', params: [accountId] },
		{ sql: 'deleted_at IS NULL', params: [] as (string | number)[] },
		...(opts.maxId ? [{ sql: 'id < ?', params: [opts.maxId] }] : []),
		...(opts.excludeReplies ? [{ sql: 'reply = 0', params: [] as (string | number)[] }] : []),
		...(opts.excludeReblogs ? [{ sql: 'reblog_of_id IS NULL', params: [] as (string | number)[] }] : []),
		...(opts.onlyMedia
			? [{ sql: 'id IN (SELECT status_id FROM media_attachments WHERE status_id IS NOT NULL)', params: [] as (string | number)[] }]
			: []),
	];
	const where = clauses.map(c => c.sql).join(' AND ');
	const params = [...clauses.flatMap(c => c.params), limit];

	const { results } = await env.DB
		.prepare(
			`SELECT * FROM statuses
			 WHERE ${where}
			 ORDER BY id DESC LIMIT ?`
		)
		.bind(...params)
		.all<Status>();
	return results;
};

export const create = async (input: CreateStatusInput): Promise<Status> => {
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

	await env.DB
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
};

export const update = async (
	id: string,
	input: Partial<Omit<Status, 'id' | 'created_at' | 'updated_at'>>
): Promise<Status | null> => {
	const now = new Date().toISOString();
	const entries = Object.entries(input);
	const fields = [...entries.map(([key]) => `${key} = ?`), 'updated_at = ?'];
	const values = [...entries.map(([, value]) => value), now, id];

	await env.DB
		.prepare(`UPDATE statuses SET ${fields.join(', ')} WHERE id = ?`)
		.bind(...values)
		.run();

	return findById(id);
};

export const deleteStatus = async (id: string): Promise<void> => {
	const now = new Date().toISOString();
	await env.DB
		.prepare('UPDATE statuses SET deleted_at = ?, updated_at = ? WHERE id = ?')
		.bind(now, now, id)
		.run();
};

export const updateCounts = async (
	id: string,
	counts: { replies_count?: number; reblogs_count?: number; favourites_count?: number }
): Promise<void> => {
	const entries = Object.entries(counts).filter(([, v]) => v !== undefined);

	if (entries.length === 0) return;

	const fields = [...entries.map(([key]) => `${key} = ?`), 'updated_at = ?'];
	const values = [...entries.map(([, value]) => value), new Date().toISOString(), id];

	await env.DB
		.prepare(`UPDATE statuses SET ${fields.join(', ')} WHERE id = ?`)
		.bind(...values)
		.run();
};

/**
 * Increment a count field atomically. Used by federation inbox processors
 * (like, announce, create) to update counts without race conditions.
 */
export const incrementCount = async (id: string, field: 'replies_count' | 'reblogs_count' | 'favourites_count'): Promise<void> => {
	await env.DB
		.prepare(`UPDATE statuses SET ${field} = ${field} + 1, updated_at = ? WHERE id = ?`)
		.bind(new Date().toISOString(), id)
		.run();
};

/**
 * Decrement a count field atomically, flooring at 0.
 */
export const decrementCount = async (id: string, field: 'replies_count' | 'reblogs_count' | 'favourites_count'): Promise<void> => {
	await env.DB
		.prepare(`UPDATE statuses SET ${field} = MAX(0, ${field} - 1), updated_at = ? WHERE id = ?`)
		.bind(new Date().toISOString(), id)
		.run();
};

/**
 * Soft-delete all statuses by account (used when deleting remote actors).
 */
export const softDeleteByAccount = async (accountId: string): Promise<void> => {
	const now = new Date().toISOString();
	await env.DB
		.prepare('UPDATE statuses SET deleted_at = ?, updated_at = ? WHERE account_id = ? AND deleted_at IS NULL')
		.bind(now, now, accountId)
		.run();
};

/**
 * Find a status by URI including deleted statuses (for processing Delete activities).
 */
export const findByUriIncludeDeleted = async (uri: string): Promise<Status | null> => {
	const result = await env.DB
		.prepare('SELECT * FROM statuses WHERE uri = ?')
		.bind(uri)
		.first<Status>();
	return result ?? null;
};

/**
 * Find a status with its parent info (for reply threading).
 */
export const findWithParent = async (id: string): Promise<(Status & { parent_account_id?: string }) | null> => {
	const result = await env.DB
		.prepare(
			`SELECT s.*, ps.account_id as parent_account_id
			 FROM statuses s
			 LEFT JOIN statuses ps ON ps.id = s.in_reply_to_id
			 WHERE s.id = ? AND s.deleted_at IS NULL`
		)
		.bind(id)
		.first<Status & { parent_account_id?: string }>();
	return result ?? null;
};

export const findContext = async (statusId: string): Promise<{ ancestors: Status[]; descendants: Status[] }> => {
	// Find ancestors by walking up in_reply_to_id chain
	const ancestors: Status[] = [];
	// oxlint-disable-next-line fp/no-let
	let currentId: string | null = statusId;

	// oxlint-disable-next-line fp/no-loop-statements
	while (currentId) {
		const parent: Status | null = await env.DB
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
	const { results: descendants } = await env.DB
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
};

export const findPublicTimeline = async (opts: TimelineOptions = {}): Promise<Status[]> => {
	const limit = opts.limit ?? 20;
	const clauses = [
		{ sql: 'deleted_at IS NULL', params: [] as (string | number)[] },
		{ sql: "visibility = 'public'", params: [] as (string | number)[] },
		{ sql: 'reblog_of_id IS NULL', params: [] as (string | number)[] },
		...(opts.maxId ? [{ sql: 'id < ?', params: [opts.maxId] }] : []),
		...(opts.sinceId ? [{ sql: 'id > ?', params: [opts.sinceId] }] : []),
		...(opts.minId ? [{ sql: 'id > ?', params: [opts.minId] }] : []),
	];
	const where = clauses.map(c => c.sql).join(' AND ');
	const params = [...clauses.flatMap(c => c.params), limit];

	const { results } = await env.DB
		.prepare(
			`SELECT * FROM statuses
			 WHERE ${where}
			 ORDER BY id DESC LIMIT ?`
		)
		.bind(...params)
		.all<Status>();
	return results;
};

export const findLocalTimeline = async (opts: TimelineOptions = {}): Promise<Status[]> => {
	const limit = opts.limit ?? 20;
	const clauses = [
		{ sql: 'deleted_at IS NULL', params: [] as (string | number)[] },
		{ sql: "visibility = 'public'", params: [] as (string | number)[] },
		{ sql: 'local = 1', params: [] as (string | number)[] },
		{ sql: 'reblog_of_id IS NULL', params: [] as (string | number)[] },
		...(opts.maxId ? [{ sql: 'id < ?', params: [opts.maxId] }] : []),
		...(opts.sinceId ? [{ sql: 'id > ?', params: [opts.sinceId] }] : []),
		...(opts.minId ? [{ sql: 'id > ?', params: [opts.minId] }] : []),
	];
	const where = clauses.map(c => c.sql).join(' AND ');
	const params = [...clauses.flatMap(c => c.params), limit];

	const { results } = await env.DB
		.prepare(
			`SELECT * FROM statuses
			 WHERE ${where}
			 ORDER BY id DESC LIMIT ?`
		)
		.bind(...params)
		.all<Status>();
	return results;
};

export const findByTag = async (tag: string, opts: TimelineOptions = {}): Promise<Status[]> => {
	const limit = opts.limit ?? 20;
	const clauses = [
		{ sql: 's.deleted_at IS NULL', params: [] as (string | number)[] },
		{ sql: "s.visibility = 'public'", params: [] as (string | number)[] },
		...(opts.maxId ? [{ sql: 's.id < ?', params: [opts.maxId] }] : []),
		...(opts.sinceId ? [{ sql: 's.id > ?', params: [opts.sinceId] }] : []),
	];
	const where = clauses.map(c => c.sql).join(' AND ');
	const params = [tag.toLowerCase(), ...clauses.flatMap(c => c.params), limit];

	const { results } = await env.DB
		.prepare(
			`SELECT s.* FROM statuses s
			 JOIN status_tags st ON st.status_id = s.id
			 JOIN tags t ON t.id = st.tag_id
			 WHERE t.name = ? AND ${where}
			 ORDER BY s.id DESC LIMIT ?`
		)
		.bind(...params)
		.all<Status>();
	return results;
};
