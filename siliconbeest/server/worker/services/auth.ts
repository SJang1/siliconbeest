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
		userStmt.bind(userId, accountId, lowerEmail, encryptedPassword, now, approved, now, now),
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

	// 2. D1 fallback — query by token_hash (NOT plaintext token)
	const row = await db
		.prepare(
			`SELECT
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
			 WHERE t.token_hash = ?
			   AND t.revoked_at IS NULL
			   AND u.disabled = 0
			   AND a.suspended_at IS NULL
			 LIMIT 1`,
		)
		.bind(tokenHash)
		.first();

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
