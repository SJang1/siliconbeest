import { Hono } from 'hono';
import type { Env, AppVariables } from '../../env';
import { generateToken } from '../../utils/crypto';
import { generateUlid } from '../../utils/ulid';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// POST /oauth/token
app.post('/', async (c) => {
	const body = await c.req.parseBody();

	const grantType = body.grant_type as string;
	const clientId = body.client_id as string;
	const clientSecret = body.client_secret as string;
	const redirectUri = body.redirect_uri as string | undefined;
	const code = body.code as string | undefined;
	const codeVerifier = body.code_verifier as string | undefined;
	const scope = (body.scope as string) ?? 'read';

	if (!grantType) {
		return c.json(
			{ error: 'invalid_request', error_description: 'grant_type is required' },
			400,
		);
	}

	// ---------------------------------------------------------------------------
	// Validate client
	// ---------------------------------------------------------------------------

	if (!clientId) {
		return c.json(
			{ error: 'invalid_client', error_description: 'client_id is required' },
			401,
		);
	}

	const oauthApp = await c.env.DB.prepare(
		`SELECT id, client_secret, redirect_uri, scopes FROM oauth_applications WHERE client_id = ?1 LIMIT 1`,
	)
		.bind(clientId)
		.first();

	if (!oauthApp) {
		return c.json(
			{ error: 'invalid_client', error_description: 'Unknown client_id' },
			401,
		);
	}

	// Verify client_secret (required for confidential clients)
	if (clientSecret && oauthApp.client_secret !== clientSecret) {
		return c.json(
			{ error: 'invalid_client', error_description: 'Invalid client_secret' },
			401,
		);
	}

	// ---------------------------------------------------------------------------
	// grant_type=authorization_code
	// ---------------------------------------------------------------------------

	if (grantType === 'authorization_code') {
		if (!code) {
			return c.json(
				{ error: 'invalid_request', error_description: 'code is required' },
				400,
			);
		}

		// Look up authorization code
		const authCode = await c.env.DB.prepare(
			`SELECT id, user_id, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at
			 FROM oauth_authorization_codes
			 WHERE code = ?1 AND application_id = ?2
			 LIMIT 1`,
		)
			.bind(code, oauthApp.id)
			.first();

		if (!authCode) {
			return c.json(
				{ error: 'invalid_grant', error_description: 'Authorization code is invalid' },
				400,
			);
		}

		// Check expiry
		if (new Date(authCode.expires_at as string) < new Date()) {
			// Clean up expired code
			await c.env.DB.prepare(
				`DELETE FROM oauth_authorization_codes WHERE id = ?1`,
			)
				.bind(authCode.id)
				.run();

			return c.json(
				{ error: 'invalid_grant', error_description: 'Authorization code has expired' },
				400,
			);
		}

		// Validate redirect_uri matches
		if (redirectUri && authCode.redirect_uri !== redirectUri) {
			return c.json(
				{ error: 'invalid_grant', error_description: 'redirect_uri mismatch' },
				400,
			);
		}

		// PKCE verification
		if (authCode.code_challenge) {
			if (!codeVerifier) {
				return c.json(
					{ error: 'invalid_grant', error_description: 'code_verifier is required' },
					400,
				);
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
				return c.json(
					{ error: 'invalid_grant', error_description: 'PKCE verification failed' },
					400,
				);
			}
		}

		// Delete the authorization code (single-use)
		await c.env.DB.prepare(
			`DELETE FROM oauth_authorization_codes WHERE id = ?1`,
		)
			.bind(authCode.id)
			.run();

		// Issue access token
		const accessToken = generateToken(64);
		const tokenId = generateUlid();
		const now = new Date().toISOString();

		await c.env.DB.prepare(
			`INSERT INTO oauth_access_tokens (id, application_id, user_id, token, scopes, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
		)
			.bind(
				tokenId,
				oauthApp.id,
				authCode.user_id,
				accessToken,
				authCode.scopes ?? scope,
				now,
			)
			.run();

		return c.json({
			access_token: accessToken,
			token_type: 'Bearer',
			scope: authCode.scopes ?? scope,
			created_at: Math.floor(new Date(now).getTime() / 1000),
		});
	}

	// ---------------------------------------------------------------------------
	// grant_type=client_credentials
	// ---------------------------------------------------------------------------

	if (grantType === 'client_credentials') {
		// Client credentials grant: app-level token, no user
		if (!clientSecret) {
			return c.json(
				{ error: 'invalid_client', error_description: 'client_secret is required for client_credentials grant' },
				401,
			);
		}

		if (oauthApp.client_secret !== clientSecret) {
			return c.json(
				{ error: 'invalid_client', error_description: 'Invalid client_secret' },
				401,
			);
		}

		const accessToken = generateToken(64);
		const tokenId = generateUlid();
		const now = new Date().toISOString();

		await c.env.DB.prepare(
			`INSERT INTO oauth_access_tokens (id, application_id, user_id, token, scopes, created_at)
			 VALUES (?1, ?2, NULL, ?3, ?4, ?5)`,
		)
			.bind(tokenId, oauthApp.id, accessToken, scope, now)
			.run();

		return c.json({
			access_token: accessToken,
			token_type: 'Bearer',
			scope,
			created_at: Math.floor(new Date(now).getTime() / 1000),
		});
	}

	// ---------------------------------------------------------------------------
	// Unsupported grant type
	// ---------------------------------------------------------------------------

	return c.json(
		{ error: 'unsupported_grant_type', error_description: `Unsupported grant_type: ${grantType}` },
		400,
	);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
	const binary = String.fromCharCode(...bytes);
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

export default app;
