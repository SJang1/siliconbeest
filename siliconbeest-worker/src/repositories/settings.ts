export interface Setting {
	key: string;
	value: string;
	updated_at: string;
}

export class SettingsRepository {
	constructor(private db: D1Database) {}

	async get(key: string): Promise<string | null> {
		const result = await this.db
			.prepare('SELECT value FROM settings WHERE key = ?')
			.bind(key)
			.first<{ value: string }>();
		return result?.value ?? null;
	}

	async set(key: string, value: string): Promise<void> {
		const now = new Date().toISOString();
		await this.db
			.prepare(
				`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
			)
			.bind(key, value, now)
			.run();
	}

	async getAll(): Promise<Setting[]> {
		const { results } = await this.db
			.prepare('SELECT * FROM settings ORDER BY key')
			.all<Setting>();
		return results;
	}

	async getMultiple(keys: string[]): Promise<Record<string, string>> {
		if (keys.length === 0) return {};
		const placeholders = keys.map(() => '?').join(', ');
		const { results } = await this.db
			.prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
			.bind(...keys)
			.all<{ key: string; value: string }>();

		const map: Record<string, string> = {};
		for (const row of results) {
			map[row.key] = row.value;
		}
		return map;
	}
}
