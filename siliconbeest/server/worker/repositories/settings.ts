import { env } from 'cloudflare:workers';

export type Setting = {
	key: string;
	value: string;
	updated_at: string;
};

export const get = async (key: string): Promise<string | null> => {
	const result = await env.DB
		.prepare('SELECT value FROM settings WHERE key = ?')
		.bind(key)
		.first<{ value: string }>();
	return result?.value ?? null;
};

export const set = async (key: string, value: string): Promise<void> => {
	const now = new Date().toISOString();
	await env.DB
		.prepare(
			`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(key, value, now)
		.run();
};

export const getAll = async (): Promise<Setting[]> => {
	const { results } = await env.DB
		.prepare('SELECT * FROM settings ORDER BY key')
		.all<Setting>();
	return results;
};

export const getMultiple = async (keys: string[]): Promise<Record<string, string>> => {
	if (keys.length === 0) return {};
	const placeholders = keys.map(() => '?').join(', ');
	const { results } = await env.DB
		.prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
		.bind(...keys)
		.all<{ key: string; value: string }>();

	return Object.fromEntries(results.map(row => [row.key, row.value]));
};
