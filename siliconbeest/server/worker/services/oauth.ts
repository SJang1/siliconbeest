/**
 * OAuth 2.0 service: application registration, authorization codes,
 * token exchange, and revocation.
 *
 * All functions are pure DB operations — no federation or queue side-effects.
 */

import { env } from 'cloudflare:workers';
import { generateUlid } from '../utils/ulid';
import { generateToken, sha256 } from '../utils/crypto';
import { createAccessToken } from './auth';
import { AppError } from '../middleware/errorHandler';
import type { OAuthApplicationRow } from '../types/db';

// ----------------------------------------------------------------
// Register OAuth application
// ----------------------------------------------------------------

export async function createOAuthApp(
	name: string,
	redirectUri: string,
	scopes: string,
	website?: string,
): Promise<OAuthApplicationRow> {
	const id = generateUlid();
	const clientId = generateToken(64);
	const clientSecret = generateToken(64);
	const now = new Date().toISOString();

	await env.DB
		.prepare(
			`INSERT INTO oauth_applications (id, name, website, redirect_uri, client_id, client_secret, scopes, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(id, name, website || null, redirectUri, clientId, clientSecret, scopes, now, now)
		.run();

	return (await env.DB.prepare('SELECT * FROM oauth_applications WHERE id = ?').bind(id).first()) as OAuthApplicationRow;
}

// ----------------------------------------------------------------
// Create authorization code
// ----------------------------------------------------------------

export async function createAuthorizationCode(
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

	await env.DB
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

export async function exchangeCode(
	code: string,
	clientId: string,
	clientSecret: string,
	redirectUri: string | undefined,
	codeVerifier?: string,
): Promise<{ token: string; scope: string; createdAt: number }> {
	// Look up the authorization code — include application_id check (security fix)
	// First resolve the application from client_id
	const app = (await env.DB
		.prepare('SELECT * FROM oauth_applications WHERE client_id = ? LIMIT 1')
		.bind(clientId)
		.first()) as OAuthApplicationRow | null;

	if (!app) {
		throw new AppError(401, 'invalid_client', 'Unknown client_id');
	}

	if (app.client_secret !== clientSecret) {
		throw new AppError(401, 'invalid_client', 'Invalid client_secret');
	}

	// Look up code scoped to this application (prevents cross-app code replay)
	const authCode = await env.DB
		.prepare(
			`SELECT id, user_id, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at
			 FROM oauth_authorization_codes
			 WHERE code = ? AND application_id = ?
			 LIMIT 1`,
		)
		.bind(code, app.id)
		.first();

	if (!authCode) {
		throw new AppError(400, 'invalid_grant', 'Authorization code is invalid');
	}

	// Check expiry
	if (new Date(authCode.expires_at as string) < new Date()) {
		// Clean up expired code
		await env.DB.prepare('DELETE FROM oauth_authorization_codes WHERE id = ?').bind(authCode.id).run();
		throw new AppError(400, 'invalid_grant', 'Authorization code has expired');
	}

	// Validate redirect_uri matches
	if (redirectUri && authCode.redirect_uri !== redirectUri) {
		throw new AppError(400, 'invalid_grant', 'redirect_uri mismatch');
	}

	// PKCE verification
	if (authCode.code_challenge) {
		if (!codeVerifier) {
			throw new AppError(400, 'invalid_grant', 'code_verifier is required');
		}

		const method = (authCode.code_challenge_method as string) || 'S256';
		let computedChallenge: string;

		if (method === 'S256') {
			const digest = await crypto.subtle.digest(
				'SHA-256',
				new TextEncoder().encode(codeVerifier),
			);
			computedChallenge = base64UrlEncode(new Uint8Array(digest));
		} else {
			// plain method
			computedChallenge = codeVerifier;
		}

		if (computedChallenge !== authCode.code_challenge) {
			throw new AppError(400, 'invalid_grant', 'PKCE verification failed');
		}
	}

	// DELETE the used code (single-use, not UPDATE used_at)
	await env.DB.prepare('DELETE FROM oauth_authorization_codes WHERE id = ?').bind(authCode.id).run();

	// Create access token via the unified service function
	const scopes = (authCode.scopes as string) ?? 'read';
	const { tokenValue, createdAt } = await createAccessToken(app.id, authCode.user_id as string, { scopes });

	return {
		token: tokenValue,
		scope: scopes,
		createdAt: Math.floor(new Date(createdAt).getTime() / 1000),
	};
}

// ----------------------------------------------------------------
// Revoke token by token_hash
// ----------------------------------------------------------------

export async function revokeToken(
	tokenHash: string,
	appId?: string,
): Promise<void> {
	const now = new Date().toISOString();

	if (appId) {
		await env.DB
			.prepare('UPDATE oauth_access_tokens SET revoked_at = ? WHERE token_hash = ? AND application_id = ? AND revoked_at IS NULL')
			.bind(now, tokenHash, appId)
			.run();
	} else {
		await env.DB
			.prepare('UPDATE oauth_access_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
			.bind(now, tokenHash)
			.run();
	}
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
	const binary = String.fromCharCode(...bytes);
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}
