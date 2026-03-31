import { generateUlid } from '../utils/ulid';
import { generateToken, sha256 } from '../utils/crypto';
import type { OAuthApplicationRow, OAuthAccessTokenRow, OAuthAuthorizationCodeRow } from '../types/db';

/**
 * OAuth 2.0 service: application registration, authorization codes,
 * token exchange, revocation, and credential verification.
 */
export class OAuthService {
	constructor(private db: D1Database) {}

	// ----------------------------------------------------------------
	// Register OAuth application
	// ----------------------------------------------------------------
	async createApplication(name: string, redirectUri: string, scopes: string, website?: string): Promise<OAuthApplicationRow> {
		const id = generateUlid();
		const clientId = generateToken(64);
		const clientSecret = generateToken(64);
		const now = new Date().toISOString();

		await this.db
			.prepare(
				`INSERT INTO oauth_applications (id, name, website, redirect_uri, client_id, client_secret, scopes, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(id, name, website || null, redirectUri, clientId, clientSecret, scopes, now, now)
			.run();

		return (await this.db.prepare('SELECT * FROM oauth_applications WHERE id = ?').bind(id).first()) as OAuthApplicationRow;
	}

	// ----------------------------------------------------------------
	// Create authorization code
	// ----------------------------------------------------------------
	async createAuthorizationCode(
		appId: string,
		userId: string,
		redirectUri: string,
		scopes: string,
		codeChallenge?: string,
		codeChallengeMethod?: string,
	): Promise<string> {
		const id = generateUlid();
		const code = generateToken(64);
		const now = new Date();
		const expiresAt = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes

		await this.db
			.prepare(
				`INSERT INTO oauth_authorization_codes
				(id, code, application_id, user_id, redirect_uri, scopes,
				 code_challenge, code_challenge_method, expires_at, used_at, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
			)
			.bind(
				id,
				code,
				appId,
				userId,
				redirectUri,
				scopes,
				codeChallenge || null,
				codeChallengeMethod || null,
				expiresAt.toISOString(),
				now.toISOString(),
			)
			.run();

		return code;
	}

	// ----------------------------------------------------------------
	// Exchange authorization code for access token
	// ----------------------------------------------------------------
	async exchangeCode(
		code: string,
		clientId: string,
		clientSecret: string,
		redirectUri: string,
		codeVerifier?: string,
	): Promise<{ token: string; scope: string; createdAt: number }> {
		// Look up the authorization code
		const authCode = (await this.db
			.prepare('SELECT * FROM oauth_authorization_codes WHERE code = ? LIMIT 1')
			.bind(code)
			.first()) as OAuthAuthorizationCodeRow | null;

		if (!authCode) {
			throw new Error('Invalid authorization code');
		}

		// Check expiry
		if (new Date(authCode.expires_at) < new Date()) {
			throw new Error('Authorization code has expired');
		}

		// Check if already used
		if (authCode.used_at) {
			throw new Error('Authorization code has already been used');
		}

		// Validate application credentials
		const app = (await this.db
			.prepare('SELECT * FROM oauth_applications WHERE id = ? LIMIT 1')
			.bind(authCode.application_id)
			.first()) as OAuthApplicationRow | null;

		if (!app) {
			throw new Error('Invalid application');
		}

		if (app.client_id !== clientId || app.client_secret !== clientSecret) {
			throw new Error('Invalid client credentials');
		}

		if (authCode.redirect_uri !== redirectUri) {
			throw new Error('Redirect URI mismatch');
		}

		// PKCE verification
		if (authCode.code_challenge) {
			if (!codeVerifier) {
				throw new Error('Code verifier is required for PKCE');
			}

			let computedChallenge: string;
			if (authCode.code_challenge_method === 'S256') {
				const hash = await sha256(codeVerifier);
				// Convert hex to base64url
				const bytes = new Uint8Array(hash.match(/.{2}/g)!.map((byte) => parseInt(byte, 16)));
				computedChallenge = base64UrlEncode(bytes);
			} else {
				// plain method
				computedChallenge = codeVerifier;
			}

			if (computedChallenge !== authCode.code_challenge) {
				throw new Error('Invalid code verifier');
			}
		}

		// Mark code as used
		await this.db
			.prepare('UPDATE oauth_authorization_codes SET used_at = ? WHERE id = ?')
			.bind(new Date().toISOString(), authCode.id)
			.run();

		// Generate access token — store SHA-256 hash, not plaintext
		const token = generateToken(64);
		const tokenHash = await sha256(token);
		const tokenId = generateUlid();
		const now = new Date();

		await this.db
			.prepare(
				`INSERT INTO oauth_access_tokens
				(id, token_hash, refresh_token, application_id, user_id, scopes, expires_at, revoked_at, created_at)
				VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL, ?)`,
			)
			.bind(tokenId, tokenHash, app.id, authCode.user_id, authCode.scopes, now.toISOString())
			.run();

		return {
			token,
			scope: authCode.scopes,
			createdAt: Math.floor(now.getTime() / 1000),
		};
	}

	// ----------------------------------------------------------------
	// Revoke token
	// ----------------------------------------------------------------
	async revokeToken(token: string, clientId: string, clientSecret: string): Promise<void> {
		// Validate client credentials
		const app = (await this.db
			.prepare('SELECT * FROM oauth_applications WHERE client_id = ? AND client_secret = ? LIMIT 1')
			.bind(clientId, clientSecret)
			.first()) as OAuthApplicationRow | null;

		if (!app) {
			throw new Error('Invalid client credentials');
		}

		const now = new Date().toISOString();
		await this.db
			.prepare('UPDATE oauth_access_tokens SET revoked_at = ? WHERE token = ? AND application_id = ?')
			.bind(now, token, app.id)
			.run();
	}

	// ----------------------------------------------------------------
	// Verify app credentials (app-level token, no user)
	// ----------------------------------------------------------------
	async verifyAppCredentials(token: string): Promise<OAuthApplicationRow | null> {
		const accessToken = (await this.db
			.prepare(
				`SELECT * FROM oauth_access_tokens
				WHERE token = ? AND revoked_at IS NULL
				AND (expires_at IS NULL OR expires_at > ?)`,
			)
			.bind(token, new Date().toISOString())
			.first()) as OAuthAccessTokenRow | null;

		if (!accessToken) {
			return null;
		}

		const app = (await this.db
			.prepare('SELECT * FROM oauth_applications WHERE id = ?')
			.bind(accessToken.application_id)
			.first()) as OAuthApplicationRow | null;

		return app;
	}
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
