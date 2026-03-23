import { generateUlid } from '../utils/ulid';
import { hashPassword, verifyPassword, generateToken, sha256 } from '../utils/crypto';
import type { AccountRow, UserRow, ActorKeyRow } from '../types/db';

/**
 * Authentication service: registration, password verification, token resolution,
 * and RSA actor keypair generation.
 */
export class AuthService {
	constructor(
		private db: D1Database,
		private kv: KVNamespace,
	) {}

	// ----------------------------------------------------------------
	// Register new user (email/password)
	// ----------------------------------------------------------------
	async register(
		email: string,
		password: string,
		username: string,
		domain: string,
		registrationMode: string,
	): Promise<{ account: AccountRow; user: UserRow }> {
		// Check registration mode
		if (registrationMode === 'closed') {
			throw new Error('Registrations are currently closed');
		}

		// Validate email
		const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
		if (!emailRegex.test(email)) {
			throw new Error('Invalid email format');
		}

		// Validate password
		if (password.length < 8) {
			throw new Error('Password must be at least 8 characters');
		}

		// Validate username (alphanumeric + underscore)
		const usernameRegex = /^[a-zA-Z0-9_]+$/;
		if (!usernameRegex.test(username)) {
			throw new Error('Username must contain only alphanumeric characters and underscores');
		}
		if (username.length < 1 || username.length > 30) {
			throw new Error('Username must be between 1 and 30 characters');
		}

		// Check for existing email
		const existingUser = await this.db
			.prepare('SELECT id FROM users WHERE email = ? LIMIT 1')
			.bind(email.toLowerCase())
			.first();
		if (existingUser) {
			throw new Error('Email is already in use');
		}

		// Check for existing username on local domain
		const existingAccount = await this.db
			.prepare('SELECT id FROM accounts WHERE username = ? AND domain IS NULL LIMIT 1')
			.bind(username.toLowerCase())
			.first();
		if (existingAccount) {
			throw new Error('Username is already taken');
		}

		const now = new Date().toISOString();
		const accountId = generateUlid();
		const userId = generateUlid();
		const actorKeyId = generateUlid();

		const encryptedPassword = await hashPassword(password);
		const { publicKeyPem, privateKeyPem } = await this.generateActorKeyPair();

		const approved = registrationMode === 'open' ? 1 : 0;
		const lowerUsername = username.toLowerCase();

		const accountStmt = this.db.prepare(
			`INSERT INTO accounts (id, username, domain, display_name, note, uri, url,
				avatar_url, avatar_static_url, header_url, header_static_url,
				locked, bot, discoverable, manually_approves_followers,
				statuses_count, followers_count, following_count,
				last_status_at, created_at, updated_at, suspended_at, silenced_at, memorial, moved_to_account_id)
			VALUES (?, ?, NULL, ?, '', ?, ?, '', '', '', '', 0, 0, 1, 0, 0, 0, 0, NULL, ?, ?, NULL, NULL, 0, NULL)`,
		);

		const userStmt = this.db.prepare(
			`INSERT INTO users (id, account_id, email, encrypted_password, locale,
				confirmed_at, confirmation_token, reset_password_token, reset_password_sent_at,
				otp_secret, otp_enabled, otp_backup_codes, role, approved, disabled,
				sign_in_count, current_sign_in_at, last_sign_in_at,
				current_sign_in_ip, last_sign_in_ip, chosen_languages, created_at, updated_at)
			VALUES (?, ?, ?, ?, 'en', ?, NULL, NULL, NULL, NULL, 0, NULL, 'user', ?, 0, 0, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
		);

		const actorKeyStmt = this.db.prepare(
			`INSERT INTO actor_keys (id, account_id, public_key, private_key, key_id, created_at)
			VALUES (?, ?, ?, ?, ?, ?)`,
		);

		const uri = `https://${domain}/users/${lowerUsername}`;
		const url = `https://${domain}/@${lowerUsername}`;
		const keyIdUri = `${uri}#main-key`;

		await this.db.batch([
			accountStmt.bind(accountId, lowerUsername, lowerUsername, uri, url, now, now),
			userStmt.bind(userId, accountId, email.toLowerCase(), encryptedPassword, now, approved, now, now),
			actorKeyStmt.bind(actorKeyId, accountId, publicKeyPem, privateKeyPem, keyIdUri, now),
		]);

		const account = (await this.db.prepare('SELECT * FROM accounts WHERE id = ?').bind(accountId).first()) as AccountRow;
		const user = (await this.db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first()) as UserRow;

		return { account, user };
	}

	// ----------------------------------------------------------------
	// Verify password
	// ----------------------------------------------------------------
	async verifyPassword(email: string, password: string): Promise<{ user: UserRow; account: AccountRow } | null> {
		const user = (await this.db
			.prepare('SELECT * FROM users WHERE email = ? LIMIT 1')
			.bind(email.toLowerCase())
			.first()) as UserRow | null;

		if (!user) {
			return null;
		}

		const valid = await verifyPassword(password, user.encrypted_password);
		if (!valid) {
			return null;
		}

		if (user.disabled) {
			return null;
		}

		const account = (await this.db.prepare('SELECT * FROM accounts WHERE id = ?').bind(user.account_id).first()) as AccountRow | null;
		if (!account) {
			return null;
		}

		if (account.suspended_at) {
			return null;
		}

		return { user, account };
	}

	// ----------------------------------------------------------------
	// Resolve bearer token to user
	// ----------------------------------------------------------------
	async resolveToken(token: string): Promise<{ user: UserRow; account: AccountRow; scopes: string } | null> {
		const tokenHash = await sha256(token);
		const cacheKey = `auth:token:${tokenHash}`;

		// Check KV cache first
		const cached = await this.kv.get(cacheKey, 'json');
		if (cached) {
			return cached as { user: UserRow; account: AccountRow; scopes: string };
		}

		// Fallback to D1 query
		const accessToken = await this.db
			.prepare(
				`SELECT oat.*, oa.scopes AS app_scopes
				FROM oauth_access_tokens oat
				JOIN oauth_applications oa ON oa.id = oat.application_id
				WHERE oat.token = ?
				AND oat.revoked_at IS NULL
				AND (oat.expires_at IS NULL OR oat.expires_at > ?)`,
			)
			.bind(token, new Date().toISOString())
			.first();

		if (!accessToken) {
			return null;
		}

		const userId = accessToken.user_id as string | null;
		if (!userId) {
			return null;
		}

		const user = (await this.db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first()) as UserRow | null;
		if (!user || user.disabled) {
			return null;
		}

		const account = (await this.db.prepare('SELECT * FROM accounts WHERE id = ?').bind(user.account_id).first()) as AccountRow | null;
		if (!account || account.suspended_at) {
			return null;
		}

		const result = {
			user,
			account,
			scopes: (accessToken.scopes as string) || 'read',
		};

		// Cache in KV for 5 minutes
		await this.kv.put(cacheKey, JSON.stringify(result), { expirationTtl: 300 });

		return result;
	}

	// ----------------------------------------------------------------
	// Generate RSA keypair for ActivityPub actor
	// ----------------------------------------------------------------
	async generateActorKeyPair(): Promise<{ publicKeyPem: string; privateKeyPem: string }> {
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

		const publicKeyBuffer = await crypto.subtle.exportKey('spki', keyPair.publicKey) as ArrayBuffer;
		const privateKeyBuffer = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey) as ArrayBuffer;

		const publicKeyPem = formatPem(publicKeyBuffer, 'PUBLIC KEY');
		const privateKeyPem = formatPem(privateKeyBuffer, 'PRIVATE KEY');

		return { publicKeyPem, privateKeyPem };
	}
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
