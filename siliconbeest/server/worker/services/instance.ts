/**
 * Instance Service
 *
 * Provides DB access for instance metadata: settings, rules, stats, and peers.
 * Used by /api/v1/instance, /api/v2/instance, /api/v1/instance/rules,
 * /api/v1/instance/peers, and admin settings endpoints.
 */

import { generateUlid } from '../utils/ulid';
import { AppError } from '../middleware/errorHandler';
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
 * Fetch ALL settings, ordered by key.
 */
export async function getAllSettings(db: D1Database): Promise<Record<string, string>> {
	const { results } = await db.prepare('SELECT * FROM settings ORDER BY key ASC').all();
	const settings: Record<string, string> = {};
	for (const row of results || []) {
		settings[row.key as string] = row.value as string;
	}
	return settings;
}

/**
 * Batch upsert settings from a key-value record.
 */
export async function setSettings(db: D1Database, entries: Record<string, string>): Promise<void> {
	const now = new Date().toISOString();
	const statements = Object.entries(entries).map(([key, value]) =>
		db.prepare(
			`INSERT INTO settings (key, value, updated_at)
			 VALUES (?1, ?2, ?3)
			 ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3`,
		).bind(key, value, now),
	);
	if (statements.length > 0) {
		await db.batch(statements);
	}
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

/**
 * Get a single rule by ID.
 */
export async function getRule(db: D1Database, id: string): Promise<Record<string, unknown>> {
	const row = await db.prepare('SELECT * FROM rules WHERE id = ?1').bind(id).first();
	if (!row) throw new AppError(404, 'Record not found');
	return row;
}

/**
 * Create a new rule.
 */
export async function createRule(
	db: D1Database,
	text: string,
	priority?: number,
): Promise<Record<string, unknown>> {
	const id = generateUlid();
	const now = new Date().toISOString();
	const prio = priority ?? 0;
	await db.prepare(
		'INSERT INTO rules (id, text, priority, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)',
	).bind(id, text, prio, now, now).run();
	const row = await db.prepare('SELECT * FROM rules WHERE id = ?1').bind(id).first();
	return row!;
}

/**
 * Update an existing rule.
 */
export async function updateRule(
	db: D1Database,
	id: string,
	data: { text?: string; priority?: number },
): Promise<Record<string, unknown>> {
	const existing = await db.prepare('SELECT * FROM rules WHERE id = ?1').bind(id).first();
	if (!existing) throw new AppError(404, 'Record not found');
	const now = new Date().toISOString();
	await db.prepare(
		'UPDATE rules SET text = ?1, priority = ?2, updated_at = ?3 WHERE id = ?4',
	).bind(
		data.text ?? existing.text,
		data.priority ?? existing.priority,
		now,
		id,
	).run();
	const row = await db.prepare('SELECT * FROM rules WHERE id = ?1').bind(id).first();
	return row!;
}

/**
 * Delete a rule by ID.
 */
export async function deleteRule(db: D1Database, id: string): Promise<void> {
	const existing = await db.prepare('SELECT * FROM rules WHERE id = ?1').bind(id).first();
	if (!existing) throw new AppError(404, 'Record not found');
	await db.prepare('DELETE FROM rules WHERE id = ?1').bind(id).run();
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
