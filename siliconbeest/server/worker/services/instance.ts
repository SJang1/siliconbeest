/**
 * Instance Service
 *
 * Provides DB access for instance metadata: settings, rules, stats, and peers.
 * Uses `env` from cloudflare:workers — no need to pass bindings as arguments.
 */

import { env } from 'cloudflare:workers';
import { generateUlid } from '../utils/ulid';
import { AppError } from '../middleware/errorHandler';
import type { AccountRow, RuleRow } from '../types/db';

// ----------------------------------------------------------------
// Settings
// ----------------------------------------------------------------

/**
 * Batch-fetch multiple settings by key.
 * Returns a record mapping each found key to its value.
 */
export async function getSettings(keys: string[]): Promise<Record<string, string>> {
	if (keys.length === 0) return {};
	const placeholders = keys.map(() => '?').join(', ');
	const { results } = await env.DB
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
export async function getAllSettings(): Promise<Record<string, string>> {
	const { results } = await env.DB.prepare('SELECT * FROM settings ORDER BY key ASC').all();
	const settings: Record<string, string> = {};
	for (const row of results || []) {
		settings[row.key as string] = row.value as string;
	}
	return settings;
}

/**
 * Batch upsert settings from a key-value record.
 */
export async function setSettings(entries: Record<string, string>): Promise<void> {
	const now = new Date().toISOString();
	const statements = Object.entries(entries).map(([key, value]) =>
		env.DB.prepare(
			`INSERT INTO settings (key, value, updated_at)
			 VALUES (?1, ?2, ?3)
			 ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3`,
		).bind(key, value, now),
	);
	if (statements.length > 0) {
		await env.DB.batch(statements);
	}
}

/**
 * Get a single setting value by key. Returns null if not found.
 */
export async function getSetting(key: string): Promise<string | null> {
	const row = await env.DB
		.prepare('SELECT value FROM settings WHERE key = ? LIMIT 1')
		.bind(key)
		.first<{ value: string }>();
	return row?.value ?? null;
}

/**
 * Upsert a setting (insert or update on conflict).
 */
export async function setSetting(key: string, value: string): Promise<void> {
	const now = new Date().toISOString();
	await env.DB
		.prepare(
			`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		)
		.bind(key, value, now)
		.run();
}

// ----------------------------------------------------------------
// Instance Title (DB setting → env fallback → default)
// ----------------------------------------------------------------

/**
 * Resolve the instance title with consistent priority:
 *   1. DB `settings.site_title` (admin-configurable)
 *   2. `INSTANCE_TITLE` env binding (deploy-time config)
 *   3. Hardcoded fallback
 */
export async function getInstanceTitle(): Promise<string> {
	const dbTitle = await getSetting('site_title');
	return dbTitle || env.INSTANCE_TITLE || 'SiliconBeest';
}

// ----------------------------------------------------------------
// Rules
// ----------------------------------------------------------------

/**
 * Fetch all instance rules, ordered by priority.
 */
export async function getRules(): Promise<RuleRow[]> {
	const { results } = await env.DB
		.prepare('SELECT * FROM rules ORDER BY priority ASC, created_at ASC')
		.all();
	return (results ?? []) as unknown as RuleRow[];
}

/**
 * Get a single rule by ID.
 */
export async function getRule(id: string): Promise<RuleRow> {
	const row = await env.DB.prepare('SELECT * FROM rules WHERE id = ?1').bind(id).first<RuleRow>();
	if (!row) throw new AppError(404, 'Record not found');
	return row;
}

/**
 * Create a new rule.
 */
export async function createRule(
	text: string,
	priority?: number,
): Promise<RuleRow> {
	const id = generateUlid();
	const now = new Date().toISOString();
	const prio = priority ?? 0;
	await env.DB.prepare(
		'INSERT INTO rules (id, text, priority, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)',
	).bind(id, text, prio, now, now).run();
	const row = await env.DB.prepare('SELECT * FROM rules WHERE id = ?1').bind(id).first<RuleRow>();
	return row!;
}

/**
 * Update an existing rule.
 */
export async function updateRule(
	id: string,
	data: { text?: string; priority?: number },
): Promise<RuleRow> {
	const existing = await env.DB.prepare('SELECT * FROM rules WHERE id = ?1').bind(id).first<RuleRow>();
	if (!existing) throw new AppError(404, 'Record not found');
	const now = new Date().toISOString();
	await env.DB.prepare(
		'UPDATE rules SET text = ?1, priority = ?2, updated_at = ?3 WHERE id = ?4',
	).bind(
		data.text ?? existing.text,
		data.priority ?? existing.priority,
		now,
		id,
	).run();
	const row = await env.DB.prepare('SELECT * FROM rules WHERE id = ?1').bind(id).first<RuleRow>();
	return row!;
}

/**
 * Delete a rule by ID.
 */
export async function deleteRule(id: string): Promise<void> {
	const existing = await env.DB.prepare('SELECT * FROM rules WHERE id = ?1').bind(id).first();
	if (!existing) throw new AppError(404, 'Record not found');
	await env.DB.prepare('DELETE FROM rules WHERE id = ?1').bind(id).run();
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
 * Caches in KV (CACHE) for 1 hour.
 */
export async function getStats(): Promise<InstanceStats> {
	const cacheKey = 'instance:stats';

	if (env.CACHE) {
		const cached = await env.CACHE.get(cacheKey, 'json');
		if (cached) return cached as InstanceStats;
	}

	const [usersResult, statusesResult, domainsResult] = await Promise.all([
		env.DB.prepare('SELECT COUNT(*) AS cnt FROM accounts WHERE domain IS NULL AND suspended_at IS NULL').first<{ cnt: number }>(),
		env.DB.prepare('SELECT COUNT(*) AS cnt FROM statuses WHERE local = 1 AND deleted_at IS NULL').first<{ cnt: number }>(),
		env.DB.prepare('SELECT COUNT(DISTINCT domain) AS cnt FROM accounts WHERE domain IS NOT NULL').first<{ cnt: number }>(),
	]);

	const stats: InstanceStats = {
		userCount: usersResult?.cnt ?? 0,
		statusCount: statusesResult?.cnt ?? 0,
		domainCount: domainsResult?.cnt ?? 0,
	};

	if (env.CACHE) {
		await env.CACHE.put(cacheKey, JSON.stringify(stats), { expirationTtl: 3600 });
	}

	return stats;
}

// ----------------------------------------------------------------
// Peers
// ----------------------------------------------------------------

/**
 * List all known peer domains, ordered alphabetically.
 */
export async function getPeers(): Promise<string[]> {
	const { results } = await env.DB
		.prepare('SELECT domain FROM instances ORDER BY domain ASC')
		.all();
	return (results ?? []).map((r) => r.domain as string);
}

// ----------------------------------------------------------------
// Email Domain Blocks
// ----------------------------------------------------------------

export async function isEmailDomainBlocked(domain: string): Promise<boolean> {
	const row = await env.DB.prepare(
		'SELECT 1 FROM email_domain_blocks WHERE domain = ?1 LIMIT 1',
	).bind(domain.toLowerCase()).first();
	return !!row;
}

// ----------------------------------------------------------------
// Contact Account
// ----------------------------------------------------------------

export async function getContactAccount(username: string): Promise<AccountRow | null> {
	return env.DB.prepare(
		'SELECT a.* FROM accounts a JOIN users u ON u.account_id = a.id WHERE a.username = ?1 AND a.domain IS NULL AND u.role = ?2 LIMIT 1',
	).bind(username, 'admin').first<AccountRow>();
}

// ----------------------------------------------------------------
// OAuth Application Lookup
// ----------------------------------------------------------------

export async function getApplicationByAccessToken(
	tokenHash: string,
	tokenPlaintext: string,
): Promise<{ name: string; website: string | null; scopes: string } | null> {
	const row = await env.DB.prepare(
		`SELECT a.name, a.website, a.scopes
		 FROM oauth_access_tokens t
		 JOIN oauth_applications a ON a.id = t.application_id
		 WHERE t.token_hash = ?1
		   AND t.revoked_at IS NULL
		 LIMIT 1`,
	).bind(tokenHash).first<{ name: string; website: string | null; scopes: string }>();
	if (row) return row;

	// Fallback for legacy plaintext tokens
	return env.DB.prepare(
		`SELECT a.name, a.website, a.scopes
		 FROM oauth_access_tokens t
		 JOIN oauth_applications a ON a.id = t.application_id
		 WHERE t.token = ?1
		   AND t.revoked_at IS NULL
		 LIMIT 1`,
	).bind(tokenPlaintext).first<{ name: string; website: string | null; scopes: string }>();
}
