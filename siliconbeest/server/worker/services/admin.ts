/**
 * Admin Service
 *
 * Pure DB operations for admin/moderation endpoints.
 * Federation delivery, queue operations, email sending, and KV cache
 * invalidation remain in the endpoint layer.
 */

import { env } from 'cloudflare:workers';
import { generateUlid } from '../utils/ulid';
import { AppError } from '../middleware/errorHandler';
import { getInstanceTitle } from './instance';

// ----------------------------------------------------------------
// Account Moderation
// ----------------------------------------------------------------

/**
 * Fetch an account by ID (minimal columns for moderation checks).
 * Throws 404 if not found.
 */
export async function getAccountForModeration(
	id: string,
): Promise<Record<string, unknown>> {
	const row = await env.DB.prepare('SELECT id, username, domain, uri FROM accounts WHERE id = ?1').bind(id).first();
	if (!row) throw new AppError(404, 'Record not found');
	return row;
}

/**
 * Mark an account as sensitized (all media marked sensitive).
 */
export async function sensitizeAccount(id: string): Promise<void> {
	const now = new Date().toISOString();
	await env.DB.prepare('UPDATE accounts SET sensitized_at = ?1 WHERE id = ?2').bind(now, id).run();
}

/**
 * Disable a user account (freeze).
 */
export async function disableAccount(accountId: string): Promise<void> {
	await env.DB.prepare('UPDATE users SET disabled = 1 WHERE account_id = ?1').bind(accountId).run();
}

/**
 * Silence an account (hide from public timelines).
 */
export async function silenceAccount(id: string): Promise<void> {
	const now = new Date().toISOString();
	await env.DB.prepare('UPDATE accounts SET silenced_at = ?1 WHERE id = ?2').bind(now, id).run();
}

/**
 * Suspend an account (full block). Returns the timestamp used.
 */
export async function suspendAccount(id: string): Promise<string> {
	const now = new Date().toISOString();
	await env.DB.prepare('UPDATE accounts SET suspended_at = ?1 WHERE id = ?2').bind(now, id).run();
	return now;
}

/**
 * Remove suspension from an account.
 */
export async function unsuspendAccount(id: string): Promise<void> {
	await env.DB.prepare('UPDATE accounts SET suspended_at = NULL WHERE id = ?1').bind(id).run();
}

/**
 * Remove silence from an account.
 */
export async function unsilenceAccount(id: string): Promise<void> {
	await env.DB.prepare('UPDATE accounts SET silenced_at = NULL WHERE id = ?1').bind(id).run();
}

/**
 * Re-enable a disabled (frozen) user account.
 */
export async function enableAccount(accountId: string): Promise<void> {
	await env.DB.prepare('UPDATE users SET disabled = 0 WHERE account_id = ?1').bind(accountId).run();
}

/**
 * Remove sensitized flag from an account.
 */
export async function unsensitizeAccount(id: string): Promise<void> {
	await env.DB.prepare('UPDATE accounts SET sensitized_at = NULL WHERE id = ?1').bind(id).run();
}

/**
 * Add a warning record for an account.
 */
export async function addAccountWarning(
	moderatorAccountId: string,
	targetAccountId: string,
	action: string,
	text: string,
	reportId?: string | null,
): Promise<string> {
	const warningId = generateUlid();
	const now = new Date().toISOString();
	await env.DB.prepare(
		'INSERT INTO account_warnings (id, account_id, target_account_id, action, text, report_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
	)
		.bind(warningId, moderatorAccountId, targetAccountId, action, text, reportId || null, now)
		.run();
	return warningId;
}

/**
 * Resolve a report (mark as acted upon).
 */
export async function resolveReport(
	reportId: string,
	moderatorAccountId: string,
): Promise<void> {
	const now = new Date().toISOString();
	await env.DB.prepare('UPDATE reports SET action_taken_at = ?1, action_taken_by_account_id = ?2 WHERE id = ?3')
		.bind(now, moderatorAccountId, reportId)
		.run();
}

/**
 * Get a user's email and locale by account ID.
 */
export async function getUserEmailByAccountId(
	accountId: string,
): Promise<{ email: string | null; locale: string | null } | null> {
	return env.DB.prepare('SELECT email, locale FROM users WHERE account_id = ?1')
		.bind(accountId)
		.first<{ email: string | null; locale: string | null }>();
}

// ----------------------------------------------------------------
// Account Approval / Rejection
// ----------------------------------------------------------------

/**
 * Get full account and user data for approval/rejection checks.
 */
export async function getAccountWithUser(
	accountId: string,
): Promise<{ account: Record<string, unknown>; user: Record<string, unknown> }> {
	const account = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?1').bind(accountId).first();
	if (!account) throw new AppError(404, 'Record not found');

	const user = await env.DB.prepare('SELECT * FROM users WHERE account_id = ?1').bind(accountId).first();
	if (!user) throw new AppError(404, 'Record not found');

	return { account, user };
}

/**
 * Approve a pending account.
 */
export async function approveAccount(accountId: string): Promise<void> {
	await env.DB.prepare('UPDATE users SET approved = 1 WHERE account_id = ?1').bind(accountId).run();
}

/**
 * Reject (delete) a pending account. Removes both user and account records.
 */
export async function rejectAccount(accountId: string): Promise<void> {
	await env.DB.batch([
		env.DB.prepare('DELETE FROM users WHERE account_id = ?1').bind(accountId),
		env.DB.prepare('DELETE FROM accounts WHERE id = ?1').bind(accountId),
	]);
}

// ----------------------------------------------------------------
// Account Role
// ----------------------------------------------------------------

/**
 * Set a user's role.
 */
export async function setAccountRole(
	accountId: string,
	role: string,
): Promise<void> {
	const account = await env.DB.prepare('SELECT id FROM accounts WHERE id = ?1').bind(accountId).first();
	if (!account) throw new AppError(404, 'Record not found');

	const user = await env.DB.prepare('SELECT id, role FROM users WHERE account_id = ?1').bind(accountId).first();
	if (!user) throw new AppError(404, 'Record not found');

	await env.DB.prepare('UPDATE users SET role = ?1, updated_at = ?2 WHERE account_id = ?3')
		.bind(role, new Date().toISOString(), accountId)
		.run();
}

/**
 * Get active access tokens for a user (for cache invalidation).
 */
export async function getActiveTokensForUser(
	userId: string,
): Promise<string[]> {
	const { results } = await env.DB.prepare(
		'SELECT token FROM oauth_access_tokens WHERE user_id = ?1 AND revoked_at IS NULL',
	).bind(userId).all();

	return (results || []).map((t) => t.token as string);
}

// ----------------------------------------------------------------
// Account Warnings History
// ----------------------------------------------------------------

/**
 * Get warning history for an account.
 */
export async function getAccountWarnings(
	accountId: string,
): Promise<Array<{ id: string; action: string; text: string; created_at: string; report_id: string | null }>> {
	const account = await env.DB.prepare('SELECT id FROM accounts WHERE id = ?1').bind(accountId).first();
	if (!account) throw new AppError(404, 'Record not found');

	const { results } = await env.DB.prepare(
		'SELECT id, action, text, created_at, report_id FROM account_warnings WHERE target_account_id = ?1 ORDER BY created_at DESC',
	).bind(accountId).all();

	return (results || []).map((row) => ({
		id: row.id as string,
		action: row.action as string,
		text: (row.text as string) || '',
		created_at: row.created_at as string,
		report_id: (row.report_id as string) || null,
	}));
}

// ----------------------------------------------------------------
// Domain Blocks
// ----------------------------------------------------------------

export async function listDomainBlocks(limit: number): Promise<Record<string, unknown>[]> {
	const { results } = await env.DB.prepare('SELECT * FROM domain_blocks ORDER BY id DESC LIMIT ?1').bind(limit).all();
	return (results || []) as Record<string, unknown>[];
}

export async function getDomainBlock(id: string): Promise<Record<string, unknown>> {
	const row = await env.DB.prepare('SELECT * FROM domain_blocks WHERE id = ?1').bind(id).first();
	if (!row) throw new AppError(404, 'Record not found');
	return row;
}

export async function createDomainBlock(
	data: {
		domain: string;
		severity?: string;
		reject_media?: boolean;
		reject_reports?: boolean;
		private_comment?: string;
		public_comment?: string;
		obfuscate?: boolean;
	},
): Promise<Record<string, unknown>> {
	const existing = await env.DB.prepare('SELECT id FROM domain_blocks WHERE domain = ?1').bind(data.domain).first();
	if (existing) throw new AppError(422, 'Domain block already exists');

	const id = generateUlid();
	const now = new Date().toISOString();
	const severity = data.severity || 'silence';

	await env.DB.prepare(
		`INSERT INTO domain_blocks (id, domain, severity, reject_media, reject_reports, private_comment, public_comment, obfuscate, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
	).bind(
		id, data.domain, severity,
		data.reject_media ? 1 : 0, data.reject_reports ? 1 : 0,
		data.private_comment || null, data.public_comment || null,
		data.obfuscate ? 1 : 0, now, now,
	).run();

	const row = await env.DB.prepare('SELECT * FROM domain_blocks WHERE id = ?1').bind(id).first();
	return row!;
}

export async function updateDomainBlock(
	id: string,
	data: {
		severity?: string;
		reject_media?: boolean;
		reject_reports?: boolean;
		private_comment?: string;
		public_comment?: string;
		obfuscate?: boolean;
	},
): Promise<{ row: Record<string, unknown>; domain: string }> {
	const existing = await env.DB.prepare('SELECT * FROM domain_blocks WHERE id = ?1').bind(id).first();
	if (!existing) throw new AppError(404, 'Record not found');

	const now = new Date().toISOString();
	await env.DB.prepare(
		`UPDATE domain_blocks SET
			severity = ?1, reject_media = ?2, reject_reports = ?3,
			private_comment = ?4, public_comment = ?5, obfuscate = ?6, updated_at = ?7
		WHERE id = ?8`,
	).bind(
		data.severity ?? existing.severity,
		data.reject_media !== undefined ? (data.reject_media ? 1 : 0) : existing.reject_media,
		data.reject_reports !== undefined ? (data.reject_reports ? 1 : 0) : existing.reject_reports,
		data.private_comment !== undefined ? data.private_comment : existing.private_comment,
		data.public_comment !== undefined ? data.public_comment : existing.public_comment,
		data.obfuscate !== undefined ? (data.obfuscate ? 1 : 0) : existing.obfuscate,
		now, id,
	).run();

	const row = await env.DB.prepare('SELECT * FROM domain_blocks WHERE id = ?1').bind(id).first();
	return { row: row!, domain: existing.domain as string };
}

export async function deleteDomainBlock(id: string): Promise<string> {
	const existing = await env.DB.prepare('SELECT * FROM domain_blocks WHERE id = ?1').bind(id).first();
	if (!existing) throw new AppError(404, 'Record not found');

	await env.DB.prepare('DELETE FROM domain_blocks WHERE id = ?1').bind(id).run();
	return existing.domain as string;
}

// ----------------------------------------------------------------
// Domain Allows
// ----------------------------------------------------------------

export async function listDomainAllows(limit: number): Promise<Record<string, unknown>[]> {
	const { results } = await env.DB.prepare('SELECT * FROM domain_allows ORDER BY id DESC LIMIT ?1').bind(limit).all();
	return (results || []) as Record<string, unknown>[];
}

export async function getDomainAllow(id: string): Promise<Record<string, unknown>> {
	const row = await env.DB.prepare('SELECT * FROM domain_allows WHERE id = ?1').bind(id).first();
	if (!row) throw new AppError(404, 'Record not found');
	return row;
}

export async function createDomainAllow(domain: string): Promise<Record<string, unknown>> {
	const existing = await env.DB.prepare('SELECT id FROM domain_allows WHERE domain = ?1').bind(domain).first();
	if (existing) throw new AppError(422, 'Domain allow already exists');

	const id = generateUlid();
	const now = new Date().toISOString();
	await env.DB.prepare(
		'INSERT INTO domain_allows (id, domain, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)',
	).bind(id, domain, now, now).run();

	const row = await env.DB.prepare('SELECT * FROM domain_allows WHERE id = ?1').bind(id).first();
	return row!;
}

export async function deleteDomainAllow(id: string): Promise<void> {
	const existing = await env.DB.prepare('SELECT * FROM domain_allows WHERE id = ?1').bind(id).first();
	if (!existing) throw new AppError(404, 'Record not found');

	await env.DB.prepare('DELETE FROM domain_allows WHERE id = ?1').bind(id).run();
}

// ----------------------------------------------------------------
// IP Blocks
// ----------------------------------------------------------------

export async function listIpBlocks(limit: number): Promise<Record<string, unknown>[]> {
	const { results } = await env.DB.prepare('SELECT * FROM ip_blocks ORDER BY id DESC LIMIT ?1').bind(limit).all();
	return (results || []) as Record<string, unknown>[];
}

export async function getIpBlock(id: string): Promise<Record<string, unknown>> {
	const row = await env.DB.prepare('SELECT * FROM ip_blocks WHERE id = ?1').bind(id).first();
	if (!row) throw new AppError(404, 'Record not found');
	return row;
}

export async function createIpBlock(
	data: { ip: string; severity: string; comment?: string; expires_in?: number },
): Promise<Record<string, unknown>> {
	const id = generateUlid();
	const now = new Date().toISOString();
	const expiresAt = data.expires_in
		? new Date(Date.now() + data.expires_in * 1000).toISOString()
		: null;

	await env.DB.prepare(
		`INSERT INTO ip_blocks (id, ip, severity, comment, expires_at, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
	).bind(id, data.ip, data.severity, data.comment || null, expiresAt, now, now).run();

	const row = await env.DB.prepare('SELECT * FROM ip_blocks WHERE id = ?1').bind(id).first();
	return row!;
}

export async function updateIpBlock(
	id: string,
	data: { ip?: string; severity?: string; comment?: string; expires_in?: number },
): Promise<Record<string, unknown>> {
	const existing = await env.DB.prepare('SELECT * FROM ip_blocks WHERE id = ?1').bind(id).first();
	if (!existing) throw new AppError(404, 'Record not found');

	const now = new Date().toISOString();
	const expiresAt = data.expires_in !== undefined
		? (data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null)
		: existing.expires_at;

	await env.DB.prepare(
		`UPDATE ip_blocks SET ip = ?1, severity = ?2, comment = ?3, expires_at = ?4, updated_at = ?5 WHERE id = ?6`,
	).bind(
		data.ip ?? existing.ip, data.severity ?? existing.severity,
		data.comment !== undefined ? data.comment : existing.comment,
		expiresAt, now, id,
	).run();

	const row = await env.DB.prepare('SELECT * FROM ip_blocks WHERE id = ?1').bind(id).first();
	return row!;
}

export async function deleteIpBlock(id: string): Promise<void> {
	const existing = await env.DB.prepare('SELECT * FROM ip_blocks WHERE id = ?1').bind(id).first();
	if (!existing) throw new AppError(404, 'Record not found');

	await env.DB.prepare('DELETE FROM ip_blocks WHERE id = ?1').bind(id).run();
}

// ----------------------------------------------------------------
// Email Domain Blocks
// ----------------------------------------------------------------

export async function listEmailDomainBlocks(limit: number): Promise<Record<string, unknown>[]> {
	const { results } = await env.DB.prepare('SELECT * FROM email_domain_blocks ORDER BY id DESC LIMIT ?1').bind(limit).all();
	return (results || []) as Record<string, unknown>[];
}

export async function getEmailDomainBlock(id: string): Promise<Record<string, unknown>> {
	const row = await env.DB.prepare('SELECT * FROM email_domain_blocks WHERE id = ?1').bind(id).first();
	if (!row) throw new AppError(404, 'Record not found');
	return row;
}

export async function createEmailDomainBlock(domain: string): Promise<Record<string, unknown>> {
	const existing = await env.DB.prepare('SELECT id FROM email_domain_blocks WHERE domain = ?1').bind(domain).first();
	if (existing) throw new AppError(422, 'Email domain block already exists');

	const id = generateUlid();
	const now = new Date().toISOString();
	await env.DB.prepare(
		'INSERT INTO email_domain_blocks (id, domain, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)',
	).bind(id, domain, now, now).run();

	const row = await env.DB.prepare('SELECT * FROM email_domain_blocks WHERE id = ?1').bind(id).first();
	return row!;
}

export async function deleteEmailDomainBlock(id: string): Promise<void> {
	const existing = await env.DB.prepare('SELECT * FROM email_domain_blocks WHERE id = ?1').bind(id).first();
	if (!existing) throw new AppError(404, 'Record not found');

	await env.DB.prepare('DELETE FROM email_domain_blocks WHERE id = ?1').bind(id).run();
}

// ----------------------------------------------------------------
// Custom Emojis
// ----------------------------------------------------------------

export async function listCustomEmojis(domain: string): Promise<Record<string, unknown>[]> {
	const { results } = await env.DB.prepare(
		`SELECT * FROM custom_emojis
		 WHERE domain IS NULL OR domain = ?1
		 ORDER BY category ASC, shortcode ASC`,
	).bind(domain).all();
	return (results ?? []) as Record<string, unknown>[];
}

export async function getCustomEmoji(id: string): Promise<Record<string, unknown>> {
	const row = await env.DB.prepare('SELECT * FROM custom_emojis WHERE id = ?1').bind(id).first();
	if (!row) throw new AppError(404, 'Record not found');
	return row;
}

export async function checkEmojiShortcodeExists(
	shortcode: string,
	instanceDomain: string,
): Promise<boolean> {
	const existing = await env.DB.prepare(
		'SELECT id FROM custom_emojis WHERE shortcode = ?1 AND (domain IS NULL OR domain = ?2)',
	).bind(shortcode, instanceDomain).first();
	return !!existing;
}

export async function createCustomEmoji(
	data: { id: string; shortcode: string; domain: string; imageKey: string; category: string | null },
): Promise<Record<string, unknown>> {
	const now = new Date().toISOString();
	await env.DB.prepare(
		`INSERT INTO custom_emojis (id, shortcode, domain, image_key, visible_in_picker, category, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7)`,
	).bind(data.id, data.shortcode, data.domain, data.imageKey, data.category, now, now).run();

	const row = await env.DB.prepare('SELECT * FROM custom_emojis WHERE id = ?1').bind(data.id).first();
	return row!;
}

export async function updateCustomEmoji(
	id: string,
	data: { category?: string | null; visible_in_picker?: boolean },
): Promise<Record<string, unknown>> {
	const existing = await env.DB.prepare('SELECT * FROM custom_emojis WHERE id = ?1').bind(id).first();
	if (!existing) throw new AppError(404, 'Record not found');

	const now = new Date().toISOString();
	await env.DB.prepare(
		`UPDATE custom_emojis SET category = ?1, visible_in_picker = ?2, updated_at = ?3 WHERE id = ?4`,
	).bind(
		data.category !== undefined ? data.category : existing.category,
		data.visible_in_picker !== undefined ? (data.visible_in_picker ? 1 : 0) : existing.visible_in_picker,
		now, id,
	).run();

	const row = await env.DB.prepare('SELECT * FROM custom_emojis WHERE id = ?1').bind(id).first();
	return row!;
}

export async function deleteCustomEmoji(id: string): Promise<string | null> {
	const existing = await env.DB.prepare('SELECT * FROM custom_emojis WHERE id = ?1').bind(id).first();
	if (!existing) throw new AppError(404, 'Record not found');

	await env.DB.prepare('DELETE FROM custom_emojis WHERE id = ?1').bind(id).run();
	return (existing.image_key as string) || null;
}

// ----------------------------------------------------------------
// Announcements
// ----------------------------------------------------------------

export async function listAnnouncements(): Promise<Record<string, unknown>[]> {
	const { results } = await env.DB.prepare('SELECT * FROM announcements ORDER BY created_at DESC').all();
	return (results || []) as Record<string, unknown>[];
}

export async function getAnnouncement(id: string): Promise<Record<string, unknown>> {
	const row = await env.DB.prepare('SELECT * FROM announcements WHERE id = ?1').bind(id).first();
	if (!row) throw new AppError(404, 'Record not found');
	return row;
}

export async function createAnnouncement(
	data: { text: string; published?: boolean; starts_at?: string; ends_at?: string; all_day?: boolean },
): Promise<Record<string, unknown>> {
	const id = generateUlid();
	const now = new Date().toISOString();
	const publishedAt = data.published !== false ? now : null;

	await env.DB.prepare(
		`INSERT INTO announcements (id, text, published_at, starts_at, ends_at, all_day, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
	).bind(id, data.text, publishedAt, data.starts_at || null, data.ends_at || null, data.all_day ? 1 : 0, now, now).run();

	const row = await env.DB.prepare('SELECT * FROM announcements WHERE id = ?1').bind(id).first();
	return row!;
}

export async function updateAnnouncement(
	id: string,
	data: { text?: string; published?: boolean; starts_at?: string; ends_at?: string; all_day?: boolean },
): Promise<Record<string, unknown>> {
	const existing = await env.DB.prepare('SELECT * FROM announcements WHERE id = ?1').bind(id).first();
	if (!existing) throw new AppError(404, 'Record not found');

	const now = new Date().toISOString();
	let publishedAt = existing.published_at;
	if (data.published === true && !existing.published_at) {
		publishedAt = now;
	} else if (data.published === false) {
		publishedAt = null;
	}

	await env.DB.prepare(
		`UPDATE announcements SET text = ?1, published_at = ?2, starts_at = ?3, ends_at = ?4, all_day = ?5, updated_at = ?6 WHERE id = ?7`,
	).bind(
		data.text ?? existing.text,
		publishedAt,
		data.starts_at !== undefined ? data.starts_at : existing.starts_at,
		data.ends_at !== undefined ? data.ends_at : existing.ends_at,
		data.all_day !== undefined ? (data.all_day ? 1 : 0) : existing.all_day,
		now, id,
	).run();

	const row = await env.DB.prepare('SELECT * FROM announcements WHERE id = ?1').bind(id).first();
	return row!;
}

export async function deleteAnnouncement(id: string): Promise<void> {
	const existing = await env.DB.prepare('SELECT * FROM announcements WHERE id = ?1').bind(id).first();
	if (!existing) throw new AppError(404, 'Record not found');

	await env.DB.batch([
		env.DB.prepare('DELETE FROM announcement_dismissals WHERE announcement_id = ?1').bind(id),
		env.DB.prepare('DELETE FROM announcements WHERE id = ?1').bind(id),
	]);
}

// ----------------------------------------------------------------
// Relays
// ----------------------------------------------------------------

export interface RelayRow {
	id: string;
	inbox_url: string;
	actor_uri: string | null;
	state: string;
	follow_activity_id: string | null;
	created_at: string;
	updated_at: string;
}

export async function listRelays(): Promise<RelayRow[]> {
	const { results } = await env.DB.prepare('SELECT * FROM relays ORDER BY created_at DESC').all<RelayRow>();
	return results || [];
}

export async function getRelay(id: string): Promise<RelayRow> {
	const row = await env.DB.prepare('SELECT * FROM relays WHERE id = ?1').bind(id).first<RelayRow>();
	if (!row) throw new AppError(404, 'Record not found');
	return row;
}

export async function checkRelayExists(inboxUrl: string): Promise<boolean> {
	const existing = await env.DB.prepare('SELECT id FROM relays WHERE inbox_url = ?1').bind(inboxUrl).first();
	return !!existing;
}

export async function createRelay(
	inboxUrl: string,
	followActivityId: string,
): Promise<RelayRow> {
	const id = generateUlid();
	const now = new Date().toISOString();

	await env.DB.prepare(
		`INSERT INTO relays (id, inbox_url, state, follow_activity_id, created_at, updated_at)
		 VALUES (?1, ?2, 'pending', ?3, ?4, ?5)`,
	).bind(id, inboxUrl, followActivityId, now, now).run();

	return (await env.DB.prepare('SELECT * FROM relays WHERE id = ?1').bind(id).first<RelayRow>())!;
}

export async function deleteRelay(id: string): Promise<void> {
	await env.DB.prepare('DELETE FROM relays WHERE id = ?1').bind(id).run();
}

/**
 * Ensure the instance actor keypair exists and return it.
 */
export async function getInstanceActorKey(domain: string): Promise<{
	public_key: string;
	private_key: string;
	key_id: string;
}> {
	const existing = await env.DB.prepare(
		"SELECT public_key, private_key, key_id FROM actor_keys WHERE account_id = '__instance__'",
	).first<{ public_key: string; private_key: string; key_id: string }>();

	if (existing) return existing;

	const keyPair = await crypto.subtle.generateKey(
		{
			name: 'RSASSA-PKCS1-v1_5',
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: 'SHA-256',
		},
		true,
		['sign', 'verify'],
	) as CryptoKeyPair;

	const pubKeyData = await crypto.subtle.exportKey('spki', keyPair.publicKey) as ArrayBuffer;
	const privKeyData = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey) as ArrayBuffer;

	const toBase64 = (buf: ArrayBuffer) => {
		const bytes = new Uint8Array(buf);
		let binary = '';
		for (const byte of bytes) binary += String.fromCharCode(byte);
		return btoa(binary);
	};
	const toPem = (b64: string, type: 'PUBLIC' | 'PRIVATE') => {
		const label = type === 'PUBLIC' ? 'PUBLIC KEY' : 'PRIVATE KEY';
		const lines: string[] = [];
		for (let i = 0; i < b64.length; i += 64) lines.push(b64.substring(i, i + 64));
		return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
	};

	const publicKeyPem = toPem(toBase64(pubKeyData), 'PUBLIC');
	const privateKeyPem = toPem(toBase64(privKeyData), 'PRIVATE');
	const keyId = `https://${domain}/actor#main-key`;
	const id = generateUlid();
	const now = new Date().toISOString();
	const title = await getInstanceTitle();

	await env.DB.prepare(
		`INSERT OR IGNORE INTO accounts (id, username, domain, display_name, note, uri, url, created_at, updated_at)
		 VALUES ('__instance__', ?1, NULL, ?2, '', ?3, ?4, ?5, ?5)`,
	).bind(domain, title, `https://${domain}/actor`, `https://${domain}/about`, now).run();

	await env.DB.prepare(
		`INSERT INTO actor_keys (id, account_id, public_key, private_key, key_id, created_at)
		 VALUES (?1, '__instance__', ?2, ?3, ?4, ?5)`,
	).bind(id, publicKeyPem, privateKeyPem, keyId, now).run();

	return { public_key: publicKeyPem, private_key: privateKeyPem, key_id: keyId };
}

// ----------------------------------------------------------------
// Federation (Instance management)
// ----------------------------------------------------------------

export async function listInstances(
	opts: { limit: number; offset: number; search?: string },
): Promise<Record<string, unknown>[]> {
	let results;
	if (opts.search) {
		const { results: rows } = await env.DB.prepare(
			`SELECT i.*, (SELECT COUNT(*) FROM accounts a WHERE a.domain = i.domain) AS account_count
			 FROM instances i WHERE i.domain LIKE ?1
			 ORDER BY i.updated_at DESC LIMIT ?2 OFFSET ?3`,
		).bind(`%${opts.search}%`, opts.limit, opts.offset).all();
		results = rows;
	} else {
		const { results: rows } = await env.DB.prepare(
			`SELECT i.*, (SELECT COUNT(*) FROM accounts a WHERE a.domain = i.domain) AS account_count
			 FROM instances i
			 ORDER BY i.updated_at DESC LIMIT ?1 OFFSET ?2`,
		).bind(opts.limit, opts.offset).all();
		results = rows;
	}
	return (results ?? []) as Record<string, unknown>[];
}

export async function getInstance(domain: string): Promise<Record<string, unknown> | null> {
	const instance = await env.DB.prepare(
		`SELECT i.*, (SELECT COUNT(*) FROM accounts a WHERE a.domain = i.domain) AS account_count
		 FROM instances i WHERE i.domain = ?`,
	).bind(domain).first();
	return instance;
}

export async function getFederationStats(): Promise<{
	total_instances: number;
	active_instances: number;
	unreachable_instances: number;
	remote_accounts: number;
}> {
	const [totalInstances, activeInstances, unreachableInstances, remoteAccounts] = await Promise.all([
		env.DB.prepare('SELECT COUNT(*) AS cnt FROM instances').first<{ cnt: number }>(),
		env.DB.prepare(
			`SELECT COUNT(*) AS cnt FROM instances
			 WHERE last_successful_at IS NOT NULL
			 AND (last_failed_at IS NULL OR last_successful_at > last_failed_at)`,
		).first<{ cnt: number }>(),
		env.DB.prepare(
			`SELECT COUNT(*) AS cnt FROM instances
			 WHERE failure_count > 0
			 AND (last_successful_at IS NULL OR last_failed_at > last_successful_at)`,
		).first<{ cnt: number }>(),
		env.DB.prepare('SELECT COUNT(*) AS cnt FROM accounts WHERE domain IS NOT NULL').first<{ cnt: number }>(),
	]);

	return {
		total_instances: totalInstances?.cnt ?? 0,
		active_instances: activeInstances?.cnt ?? 0,
		unreachable_instances: unreachableInstances?.cnt ?? 0,
		remote_accounts: remoteAccounts?.cnt ?? 0,
	};
}
