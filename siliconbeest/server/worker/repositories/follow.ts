import { env } from 'cloudflare:workers';
import { generateUlid } from '../utils/ulid';

export type Follow = {
	id: string;
	account_id: string;
	target_account_id: string;
	uri: string | null;
	show_reblogs: number;
	notify: number;
	languages: string | null;
	created_at: string;
	updated_at: string;
};

export type CreateFollowInput = {
	account_id: string;
	target_account_id: string;
	uri?: string | null;
	show_reblogs?: number;
	notify?: number;
	languages?: string | null;
};

export const findById = async (
	id: string,
): Promise<Follow | null> => {
	const result = await env.DB
		.prepare('SELECT * FROM follows WHERE id = ?')
		.bind(id)
		.first<Follow>();
	return result ?? null;
};

export const findByAccountAndTarget = async (
	accountId: string,
	targetAccountId: string,
): Promise<Follow | null> => {
	const result = await env.DB
		.prepare('SELECT * FROM follows WHERE account_id = ? AND target_account_id = ?')
		.bind(accountId, targetAccountId)
		.first<Follow>();
	return result ?? null;
};

export const findFollowers = async (
	accountId: string,
	limit: number = 40,
	maxId?: string,
): Promise<Follow[]> => {
	const clauses = [
		{ sql: 'target_account_id = ?', param: accountId },
		...(maxId ? [{ sql: 'id < ?', param: maxId }] : []),
	];
	const where = clauses.map(c => c.sql).join(' AND ');
	const params = [...clauses.map(c => c.param), limit];

	const { results } = await env.DB
		.prepare(
			`SELECT * FROM follows
			 WHERE ${where}
			 ORDER BY id DESC LIMIT ?`
		)
		.bind(...params)
		.all<Follow>();
	return results;
};

export const findFollowing = async (
	accountId: string,
	limit: number = 40,
	maxId?: string,
): Promise<Follow[]> => {
	const clauses = [
		{ sql: 'account_id = ?', param: accountId },
		...(maxId ? [{ sql: 'id < ?', param: maxId }] : []),
	];
	const where = clauses.map(c => c.sql).join(' AND ');
	const params = [...clauses.map(c => c.param), limit];

	const { results } = await env.DB
		.prepare(
			`SELECT * FROM follows
			 WHERE ${where}
			 ORDER BY id DESC LIMIT ?`
		)
		.bind(...params)
		.all<Follow>();
	return results;
};

export const create = async (
	input: CreateFollowInput,
): Promise<Follow> => {
	const now = new Date().toISOString();
	const id = generateUlid();
	const follow: Follow = {
		id,
		account_id: input.account_id,
		target_account_id: input.target_account_id,
		uri: input.uri ?? null,
		show_reblogs: input.show_reblogs ?? 1,
		notify: input.notify ?? 0,
		languages: input.languages ?? null,
		created_at: now,
		updated_at: now,
	};

	await env.DB
		.prepare(
			`INSERT INTO follows (
				id, account_id, target_account_id, uri,
				show_reblogs, notify, languages, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			follow.id, follow.account_id, follow.target_account_id, follow.uri,
			follow.show_reblogs, follow.notify, follow.languages,
			follow.created_at, follow.updated_at
		)
		.run();

	return follow;
};

export const deleteById = async (
	id: string,
): Promise<void> => {
	await env.DB
		.prepare('DELETE FROM follows WHERE id = ?')
		.bind(id)
		.run();
};

export const countFollowers = async (
	accountId: string,
): Promise<number> => {
	const result = await env.DB
		.prepare('SELECT COUNT(*) as count FROM follows WHERE target_account_id = ?')
		.bind(accountId)
		.first<{ count: number }>();
	return result?.count ?? 0;
};

export const countFollowing = async (
	accountId: string,
): Promise<number> => {
	const result = await env.DB
		.prepare('SELECT COUNT(*) as count FROM follows WHERE account_id = ?')
		.bind(accountId)
		.first<{ count: number }>();
	return result?.count ?? 0;
};

export const findRemoteFollowerInboxes = async (
	accountId: string,
): Promise<string[]> => {
	const { results } = await env.DB
		.prepare(
			`SELECT DISTINCT a.uri FROM follows f
			 JOIN accounts a ON a.id = f.account_id
			 WHERE f.target_account_id = ? AND a.domain IS NOT NULL`
		)
		.bind(accountId)
		.all<{ uri: string }>();

	// Derive inbox URLs from actor URIs: {actor_uri}/inbox
	// In practice, the inbox URL is stored on the instance or fetched via WebFinger.
	// This returns the actor URIs; the caller should resolve to shared inboxes.
	return [...new Set(results.map((r) => r.uri))];
};
