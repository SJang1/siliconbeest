/**
 * Instance Service
 *
 * Provides DB access for instance metadata: settings, rules, stats, and peers.
 * Used by /api/v1/instance, /api/v2/instance, /api/v1/instance/rules,
 * /api/v1/instance/peers, and admin settings endpoints.
 */

import type { RuleRow } from '../types/db';

// ----------------------------------------------------------------
// Settings
// ----------------------------------------------------------------

/**
 * Batch-fetch multiple settings by key.
 * Returns a record mapping each found key to its value.
 */
export async function getSettings(
	db: D1Database,
	keys: string[],
): Promise<Record<string, string>> {
	if (keys.length === 0) return {};
	const placeholders = keys.map(() => '?').join(', ');
	const { results } = await db
		.prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
		.bind(...keys)
		.all();

	const map: Record<string, string> = {};
	for (const row of results ?? []) {
		map[row.key as string] = row.value as string;
	}
	return map;
}

/**
 * Get a single setting value by key. Returns null if not found.
 */
export async function getSetting(db: D1Database, key: string): Promise<string | null> {
	const row = await db
		.prepare('SELECT value FROM settings WHERE key = ? LIMIT 1')
		.bind(key)
		.first<{ value: string }>();
	return row?.value ?? null;
}

/**
 * Upsert a setting (insert or update on conflict).
 */
export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
	const now = new Date().toISOString();
	await db
		.prepare(
			`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		)
		.bind(key, value, now)
		.run();
}

// ----------------------------------------------------------------
// Rules
// ----------------------------------------------------------------

/**
 * Fetch all instance rules, ordered by priority.
 */
export async function getRules(db: D1Database): Promise<RuleRow[]> {
	const { results } = await db
		.prepare('SELECT * FROM rules ORDER BY priority ASC, created_at ASC')
		.all();
	return (results ?? []) as unknown as RuleRow[];
}

// ----------------------------------------------------------------
// Stats
// ----------------------------------------------------------------

export interface InstanceStats {
	userCount: number;
	statusCount: number;
	domainCount: number;
}

/**
 * Compute instance stats (user count, status count, known domain count).
 * Optionally caches in KV for 1 hour.
 */
export async function getStats(
	db: D1Database,
	kv?: KVNamespace,
): Promise<InstanceStats> {
	const cacheKey = 'instance:stats';

	if (kv) {
		const cached = await kv.get(cacheKey, 'json');
		if (cached) return cached as InstanceStats;
	}

	const [usersResult, statusesResult, domainsResult] = await Promise.all([
		db.prepare('SELECT COUNT(*) AS cnt FROM accounts WHERE domain IS NULL AND suspended_at IS NULL').first<{ cnt: number }>(),
		db.prepare('SELECT COUNT(*) AS cnt FROM statuses WHERE local = 1 AND deleted_at IS NULL').first<{ cnt: number }>(),
		db.prepare('SELECT COUNT(DISTINCT domain) AS cnt FROM accounts WHERE domain IS NOT NULL').first<{ cnt: number }>(),
	]);

	const stats: InstanceStats = {
		userCount: usersResult?.cnt ?? 0,
		statusCount: statusesResult?.cnt ?? 0,
		domainCount: domainsResult?.cnt ?? 0,
	};

	if (kv) {
		await kv.put(cacheKey, JSON.stringify(stats), { expirationTtl: 3600 });
	}

	return stats;
}

// ----------------------------------------------------------------
// Peers
// ----------------------------------------------------------------

/**
 * List all known peer domains, ordered alphabetically.
 */
export async function getPeers(db: D1Database): Promise<string[]> {
	const { results } = await db
		.prepare('SELECT domain FROM instances ORDER BY domain ASC')
		.all();
	return (results ?? []).map((r) => r.domain as string);
}
