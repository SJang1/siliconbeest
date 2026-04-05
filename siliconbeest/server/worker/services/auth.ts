/**
 * Authentication service: registration, password verification, token resolution,
 * and RSA actor keypair generation.
 *
 * All functions are pure DB operations — no federation or queue side-effects.
 */

import * as v from 'valibot';
import { generateUlid } from '../utils/ulid';
import { hashPassword, verifyPassword as verifyPasswordHash, generateToken, sha256, generateEd25519KeyPair } from '../utils/crypto';
import { AppError } from '../middleware/errorHandler';
import type { AccountRow, UserRow } from '../types/db';

// ----------------------------------------------------------------
// Input schemas
// ----------------------------------------------------------------

export const RegisterInput = v.object({
	email: v.pipe(v.string(), v.email()),
	password: v.pipe(v.string(), v.minLength(8)),
	username: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_]+$/), v.maxLength(30)),
});

// ----------------------------------------------------------------
// Token resolution payload (matches middleware/auth.ts TokenPayload)
// ----------------------------------------------------------------

export interface ResolvedToken {
	tokenId: string;
	user: { id: string; account_id: string; email: string; role: string };
	account: { id: string; username: string; domain: string | null };
	scopes: string;
}

// ----------------------------------------------------------------
// Register a new user (email/password)
// ----------------------------------------------------------------

export async function registerUser(
	db: D1Database,
	domain: string,
	email: string,
	password: string,
	username: string,
	registrationMode: string,
): Promise<{ account: AccountRow; user: UserRow }> {
	if (registrationMode === 'closed' || registrationMode === 'none') {
		throw new AppError(403, 'Registrations are currently closed');
	}

	// Validate input via schema
	const parsed = v.safeParse(RegisterInput, { email, password, username });
	if (!parsed.success) {
		const issue = parsed.issues[0];
		throw new AppError(422, 'Validation failed', issue?.message ?? 'Invalid input');
	}

	const lowerEmail = email.toLowerCase();
	const lowerUsername = username.toLowerCase();

	// Check for existing email
	const existingUser = await db
		.prepare('SELECT id FROM users WHERE email = ? LIMIT 1')
		.bind(lowerEmail)
		.first();
	if (existingUser) {
		throw new AppError(422, 'Validation failed', 'Email is already in use');
	}

	// Check for existing username on local domain
	const existingAccount = await db
		.prepare('SELECT id FROM accounts WHERE username = ? AND domain IS NULL LIMIT 1')
		.bind(lowerUsername)
		.first();
	if (existingAccount) {
		throw new AppError(422, 'Validation failed', 'Username is already taken');
	}

	const now = new Date().toISOString();
	const accountId = generateUlid();
	const userId = generateUlid();
	const actorKeyId = generateUlid();

	const encryptedPassword = await hashPassword(password);
	const { publicKeyPem, privateKeyPem } = await generateActorKeyPair();
	const ed25519Keys = await generateEd25519KeyPair();

	const approved = registrationMode === 'open' ? 1 : 0;

	const uri = `https://${domain}/users/${lowerUsername}`;
	const url = `https://${domain}/@${lowerUsername}`;
	const keyIdUri = `${uri}#main-key`;

	const accountStmt = db.prepare(
		`INSERT INTO accounts (id, username, domain, display_name, note, uri, url,
			avatar_url, avatar_static_url, header_url, header_static_url,
			locked, bot, discoverable, manually_approves_followers,
			statuses_count, followers_count, following_count,
			last_status_at, created_at, updated_at, suspended_at, silenced_at, memorial, moved_to_account_id)
		VALUES (?, ?, NULL, ?, '', ?, ?, '', '', '', '', 0, 0, 1, 0, 0, 0, 0, NULL, ?, ?, NULL, NULL, 0, NULL)`,
	);

	const userStmt = db.prepare(
		`INSERT INTO users (id, account_id, email, encrypted_password, locale,
			confirmed_at, confirmation_token, reset_password_token, reset_password_sent_at,
			otp_secret, otp_enabled, otp_backup_codes, role, approved, disabled,
			sign_in_count, current_sign_in_at, last_sign_in_at,
			current_sign_in_ip, last_sign_in_ip, chosen_languages, created_at, updated_at)
		VALUES (?, ?, ?, ?, 'en', ?, NULL, NULL, NULL, NULL, 0, NULL, 'user', ?, 0, 0, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
	);

	const actorKeyStmt = db.prepare(
		`INSERT INTO actor_keys (id, account_id, public_key, private_key, key_id, ed25519_public_key, ed25519_private_key, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	await db.batch([
		accountStmt.bind(accountId, lowerUsername, lowerUsername, uri, url, now, now),
		userStmt.bind(userId, accountId, lowerEmail, encryptedPassword, null, approved, now, now),
		actorKeyStmt.bind(actorKeyId, accountId, publicKeyPem, privateKeyPem, keyIdUri, ed25519Keys.publicKey, ed25519Keys.privateKey, now),
	]);

	const account = (await db.prepare('SELECT * FROM accounts WHERE id = ?').bind(accountId).first()) as AccountRow;
	const user = (await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first()) as UserRow;

	return { account, user };
}

// ----------------------------------------------------------------
// Verify password (returns user + account or null)
// ----------------------------------------------------------------

export async function verifyPassword(
	db: D1Database,
	email: string,
	password: string,
): Promise<{ user: UserRow; account: AccountRow } | null> {
	const user = (await db
		.prepare('SELECT * FROM users WHERE email = ? LIMIT 1')
		.bind(email.toLowerCase())
		.first()) as UserRow | null;

	if (!user) return null;

	const valid = await verifyPasswordHash(password, user.encrypted_password);
	if (!valid) return null;

	if (user.disabled) return null;

	const account = (await db
		.prepare('SELECT * FROM accounts WHERE id = ?')
		.bind(user.account_id)
		.first()) as AccountRow | null;

	if (!account) return null;
	if (account.suspended_at) return null;

	return { user, account };
}

// ----------------------------------------------------------------
// Resolve token_hash to user + account + scopes
// ----------------------------------------------------------------

export async function resolveToken(
	db: D1Database,
	kv: KVNamespace,
	tokenHash: string,
	rawToken?: string,
): Promise<ResolvedToken | null> {
	const cacheKey = `token:${tokenHash}`;

	// 1. KV cache lookup
	const cached = await kv.get(cacheKey, 'json');
	if (cached) {
		const payload = cached as ResolvedToken;
		// Verify the account is not suspended/disabled (prevents stale-cache abuse)
		const check = await db
			.prepare(
				`SELECT u.disabled, a.suspended_at
				 FROM users u JOIN accounts a ON a.id = u.account_id
				 WHERE u.id = ? LIMIT 1`,
			)
			.bind(payload.user.id)
			.first();
		if (!check || check.disabled || check.suspended_at) {
			await kv.delete(cacheKey);
			return null;
		}
		return payload;
	}

	// 2. D1 fallback — query by token_hash, with legacy plaintext fallback
	const tokenQuery = `SELECT
		   t.id   AS token_id,
		   u.id   AS user_id,
		   u.email,
		   u.role,
		   a.id       AS account_id,
		   a.username,
		   a.domain,
		   t.scopes
		 FROM oauth_access_tokens t
		 JOIN users    u ON u.id = t.user_id
		 JOIN accounts a ON a.id = u.account_id
		 WHERE t.revoked_at IS NULL
		   AND u.disabled = 0
		   AND a.suspended_at IS NULL
		   AND (t.token_hash = ?1 OR t.token = ?2)
		 LIMIT 1`;

	const row = await db.prepare(tokenQuery).bind(tokenHash, rawToken ?? tokenHash).first();

	if (!row) return null;

	const payload: ResolvedToken = {
		tokenId: row.token_id as string,
		user: {
			id: row.user_id as string,
			account_id: row.account_id as string,
			email: row.email as string,
			role: row.role as string,
		},
		account: {
			id: row.account_id as string,
			username: row.username as string,
			domain: (row.domain as string) ?? null,
		},
		scopes: (row.scopes as string) || 'read',
	};

	// 3. Populate cache (5-min TTL)
	await kv.put(cacheKey, JSON.stringify(payload), { expirationTtl: 300 });

	return payload;
}

// ----------------------------------------------------------------
// Generate RSA keypair for ActivityPub actor
// ----------------------------------------------------------------

export async function generateActorKeyPair(): Promise<{ publicKeyPem: string; privateKeyPem: string }> {
	const keyPair = (await crypto.subtle.generateKey(
		{
			name: 'RSASSA-PKCS1-v1_5',
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: 'SHA-256',
		},
		true,
		['sign', 'verify'],
	)) as CryptoKeyPair;

	const publicKeyBuffer = (await crypto.subtle.exportKey('spki', keyPair.publicKey)) as ArrayBuffer;
	const privateKeyBuffer = (await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)) as ArrayBuffer;

	const publicKeyPem = formatPem(publicKeyBuffer, 'PUBLIC KEY');
	const privateKeyPem = formatPem(privateKeyBuffer, 'PRIVATE KEY');

	return { publicKeyPem, privateKeyPem };
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function formatPem(keyBuffer: ArrayBuffer, label: string): string {
	const base64 = arrayBufferToBase64(keyBuffer);
	const lines: string[] = [];
	for (let i = 0; i < base64.length; i += 64) {
		lines.push(base64.substring(i, i + 64));
	}
	return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

// ----------------------------------------------------------------
// Password management (change password, request reset, execute reset)
// ----------------------------------------------------------------

/**
 * Change a user's password. Verifies the current password first.
 */
export async function changePassword(
	db: D1Database,
	userId: string,
	currentPassword: string,
	newPassword: string,
): Promise<void> {
	const user = await db.prepare('SELECT encrypted_password FROM users WHERE id = ?1')
		.bind(userId)
		.first();

	if (!user) throw new AppError(404, 'Record not found');

	const valid = await verifyPasswordHash(currentPassword, user.encrypted_password as string);
	if (!valid) {
		throw new AppError(422, 'Current password is incorrect');
	}

	const hashed = await hashPassword(newPassword);
	await db.prepare('UPDATE users SET encrypted_password = ?1, updated_at = ?2 WHERE id = ?3')
		.bind(hashed, new Date().toISOString(), userId)
		.run();
}

/**
 * Store a password reset token for a user found by email.
 * Returns the user row if found, null otherwise.
 */
export async function createPasswordResetToken(
	db: D1Database,
	email: string,
): Promise<{ userId: string; locale: string | null; token: string } | null> {
	const user = await db.prepare('SELECT id, email, locale FROM users WHERE email = ?1')
		.bind(email)
		.first();

	if (!user) return null;

	const token = generateToken(64);
	const now = new Date().toISOString();

	await db.prepare(
		'UPDATE users SET reset_password_token = ?1, reset_password_sent_at = ?2 WHERE id = ?3',
	).bind(token, now, user.id).run();

	return { userId: user.id as string, locale: (user.locale as string) || null, token };
}

/**
 * Reset a user's password using a valid reset token.
 * Throws if token is invalid or expired.
 */
export async function resetPasswordWithToken(
	db: D1Database,
	token: string,
	newPassword: string,
): Promise<void> {
	const user = await db.prepare(
		'SELECT id, reset_password_sent_at FROM users WHERE reset_password_token = ?1',
	).bind(token).first();

	if (!user) {
		throw new AppError(422, 'Reset token is invalid or has expired');
	}

	// Check expiry (1 hour)
	const sentAt = user.reset_password_sent_at as string | null;
	if (sentAt) {
		const sentTime = new Date(sentAt).getTime();
		const now = Date.now();
		const oneHour = 60 * 60 * 1000;
		if (now - sentTime > oneHour) {
			throw new AppError(422, 'Reset token is invalid or has expired');
		}
	}

	const hashed = await hashPassword(newPassword);
	await db.prepare(
		'UPDATE users SET encrypted_password = ?1, reset_password_token = NULL, reset_password_sent_at = NULL, updated_at = ?2 WHERE id = ?3',
	).bind(hashed, new Date().toISOString(), user.id).run();
}

// ----------------------------------------------------------------
// Email confirmation
// ----------------------------------------------------------------

/**
 * Look up a user by email for resend-confirmation flow.
 * Returns user info if found and not yet confirmed.
 */
export async function getUserForConfirmation(
	db: D1Database,
	email: string,
): Promise<{ id: string; confirmed_at: string | null; confirmation_token: string | null } | null> {
	return db.prepare(
		'SELECT id, confirmed_at, confirmation_token FROM users WHERE email = ?1 LIMIT 1',
	).bind(email).first<{ id: string; confirmed_at: string | null; confirmation_token: string | null }>();
}

/**
 * Update the confirmation token for a user.
 */
export async function setConfirmationToken(
	db: D1Database,
	userId: string,
	token: string,
): Promise<void> {
	await db.prepare('UPDATE users SET confirmation_token = ?1 WHERE id = ?2').bind(token, userId).run();
}

// ----------------------------------------------------------------
// WebAuthn DB operations
// ----------------------------------------------------------------

/**
 * Get existing WebAuthn credentials for a user (for excludeCredentials).
 */
export async function getWebAuthnCredentials(
	db: D1Database,
	userId: string,
): Promise<Array<{ credential_id: string; transports: string | null }>> {
	const { results } = await db.prepare(
		'SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?1',
	).bind(userId).all<{ credential_id: string; transports: string | null }>();

	return results || [];
}

/**
 * Store a new WebAuthn credential.
 */
export async function storeWebAuthnCredential(
	db: D1Database,
	data: {
		id: string;
		userId: string;
		credentialId: string;
		publicKey: string;
		counter: number;
		deviceType: string;
		backedUp: boolean;
		transports: string | null;
		name: string | null;
	},
): Promise<void> {
	const now = new Date().toISOString();
	await db.prepare(
		`INSERT INTO webauthn_credentials (id, user_id, credential_id, public_key, counter, device_type, backed_up, transports, name, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
	).bind(
		data.id, data.userId, data.credentialId, data.publicKey,
		data.counter, data.deviceType, data.backedUp ? 1 : 0,
		data.transports, data.name, now,
	).run();
}

/**
 * Look up a WebAuthn credential by credential_id.
 */
export async function getWebAuthnCredentialByCredentialId(
	db: D1Database,
	credentialId: string,
): Promise<{ id: string; user_id: string; credential_id: string; public_key: string; counter: number } | null> {
	return db.prepare(
		`SELECT wc.id, wc.user_id, wc.credential_id, wc.public_key, wc.counter
		 FROM webauthn_credentials wc
		 WHERE wc.credential_id = ?1
		 LIMIT 1`,
	).bind(credentialId).first<{
		id: string;
		user_id: string;
		credential_id: string;
		public_key: string;
		counter: number;
	}>();
}

/**
 * Update sign counter and last_used_at for a WebAuthn credential.
 */
export async function updateWebAuthnCredentialCounter(
	db: D1Database,
	credId: string,
	newCounter: number,
): Promise<void> {
	const now = new Date().toISOString();
	await db.prepare(
		'UPDATE webauthn_credentials SET counter = ?1, last_used_at = ?2 WHERE id = ?3',
	).bind(newCounter, now, credId).run();
}

/**
 * Look up a user by user_id for WebAuthn auth verification.
 */
export async function getUserForWebAuthn(
	db: D1Database,
	userId: string,
): Promise<{
	id: string;
	account_id: string;
	email: string;
	role: string;
	approved: number;
	disabled: number;
	confirmed_at: string | null;
	username: string;
	display_name: string;
} | null> {
	return db.prepare(
		`SELECT u.id, u.account_id, u.email, u.role, u.approved, u.disabled, u.confirmed_at,
		        a.username, a.display_name
		 FROM users u
		 JOIN accounts a ON a.id = u.account_id
		 WHERE u.id = ?1 LIMIT 1`,
	).bind(userId).first();
}

/**
 * Get or create the internal OAuth application for WebAuthn.
 */
export async function getOrCreateInternalApp(
	db: D1Database,
): Promise<{ id: string; client_id: string }> {
	const INTERNAL_APP_NAME = '__siliconbeest_web__';
	let appRecord = await db.prepare(
		"SELECT id, client_id FROM oauth_applications WHERE name = ?1 LIMIT 1",
	).bind(INTERNAL_APP_NAME).first<{ id: string; client_id: string }>();

	if (!appRecord) {
		const appId = generateUlid();
		const clientId = crypto.randomUUID().replace(/-/g, '');
		const clientSecret = crypto.randomUUID().replace(/-/g, '');
		const now = new Date().toISOString();
		await db.prepare(
			`INSERT INTO oauth_applications (id, name, redirect_uri, client_id, client_secret, scopes, created_at, updated_at)
			 VALUES (?1, ?2, 'urn:ietf:wg:oauth:2.0:oob', ?3, ?4, 'read write follow push', ?5, ?5)`,
		).bind(appId, INTERNAL_APP_NAME, clientId, clientSecret, now).run();
		appRecord = { id: appId, client_id: clientId };
	}

	return appRecord;
}

/**
 * Create an OAuth access token for a user.
 */
export async function createAccessToken(
	db: D1Database,
	applicationId: string,
	userId: string,
): Promise<{ tokenValue: string; tokenId: string; createdAt: string }> {
	const tokenValue = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
	const tokenHash = await sha256(tokenValue);
	const tokenId = generateUlid();
	const now = new Date().toISOString();

	await db.prepare(
		`INSERT INTO oauth_access_tokens (id, token_hash, application_id, user_id, scopes, created_at)
		 VALUES (?1, ?2, ?3, ?4, 'read write follow push', ?5)`,
	).bind(tokenId, tokenHash, applicationId, userId, now).run();

	return { tokenValue, tokenId, createdAt: now };
}

/**
 * Update sign-in tracking for a user.
 */
export async function updateSignInTracking(
	db: D1Database,
	userId: string,
	ip: string,
): Promise<void> {
	const now = new Date().toISOString();
	await db.prepare(
		`UPDATE users SET sign_in_count = sign_in_count + 1,
		 last_sign_in_at = current_sign_in_at, last_sign_in_ip = current_sign_in_ip,
		 current_sign_in_at = ?1, current_sign_in_ip = ?2
		 WHERE id = ?3`,
	).bind(now, ip, userId).run();
}

/**
 * List all WebAuthn credentials for a user.
 */
export async function listWebAuthnCredentials(
	db: D1Database,
	userId: string,
): Promise<Array<{
	id: string;
	credential_id: string;
	device_type: string | null;
	backed_up: number;
	transports: string | null;
	name: string | null;
	created_at: string;
	last_used_at: string | null;
}>> {
	const result = await db.prepare(
		`SELECT id, credential_id, device_type, backed_up, transports, name, created_at, last_used_at
		 FROM webauthn_credentials
		 WHERE user_id = ?1
		 ORDER BY created_at DESC`,
	).bind(userId).all<{
		id: string;
		credential_id: string;
		device_type: string | null;
		backed_up: number;
		transports: string | null;
		name: string | null;
		created_at: string;
		last_used_at: string | null;
	}>();

	return result.results || [];
}

/**
 * Delete a WebAuthn credential. Returns the number of rows changed.
 */
export async function deleteWebAuthnCredential(
	db: D1Database,
	credId: string,
	userId: string,
): Promise<number> {
	const result = await db.prepare(
		'DELETE FROM webauthn_credentials WHERE id = ?1 AND user_id = ?2',
	).bind(credId, userId).run();

	return result.meta.changes || 0;
}

/**
 * Look up WebAuthn credentials for a user found by email (for authenticate/options).
 */
export async function getWebAuthnCredentialsByEmail(
	db: D1Database,
	email: string,
): Promise<Array<{ credential_id: string; transports: string | null }>> {
	const user = await db.prepare(
		'SELECT id FROM users WHERE email = ?1 LIMIT 1',
	).bind(email.toLowerCase().trim()).first<{ id: string }>();

	if (!user) return [];

	const creds = await db.prepare(
		'SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?1',
	).bind(user.id).all<{ credential_id: string; transports: string | null }>();

	return creds.results || [];
}
