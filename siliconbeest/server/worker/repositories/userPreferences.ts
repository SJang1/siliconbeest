import { env } from 'cloudflare:workers';
import { generateUlid } from '../utils/ulid';

export const getByUserId = async (userId: string): Promise<Record<string, string>> => {
	const { results } = await env.DB
		.prepare('SELECT key, value FROM user_preferences WHERE user_id = ?')
		.bind(userId)
		.all<{ key: string; value: string }>();

	return Object.fromEntries(results.map((row) => [row.key, row.value]));
};

export const getByUserIdAndKeys = async (
	userId: string,
	keys: string[],
): Promise<Record<string, string>> => {
	if (keys.length === 0) return {};
	const placeholders = keys.map(() => '?').join(', ');
	const { results } = await env.DB
		.prepare(`SELECT key, value FROM user_preferences WHERE user_id = ? AND key IN (${placeholders})`)
		.bind(userId, ...keys)
		.all<{ key: string; value: string }>();

	return Object.fromEntries(results.map((row) => [row.key, row.value]));
};

export const set = async (userId: string, key: string, value: string): Promise<void> => {
	const id = generateUlid();
	await env.DB
		.prepare(
			`INSERT INTO user_preferences (id, user_id, key, value)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
		)
		.bind(id, userId, key, value)
		.run();
};
