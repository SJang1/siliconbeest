import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../types';
import { exchangeCode } from '../../services/oauth';
import { createAccessToken } from '../../services/auth';
import { AppError } from '../../middleware/errorHandler';

const app = new Hono<{ Variables: AppVariables }>();

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

	// ---------------------------------------------------------------------------
	// grant_type=authorization_code — delegate to oauth service
	// ---------------------------------------------------------------------------

	if (grantType === 'authorization_code') {
		if (!code) {
			return c.json(
				{ error: 'invalid_request', error_description: 'code is required' },
				400,
			);
		}

		if (!clientSecret) {
			return c.json(
				{ error: 'invalid_client', error_description: 'client_secret is required' },
				401,
			);
		}

		try {
			const result = await exchangeCode(code, clientId, clientSecret, redirectUri, codeVerifier);

			return c.json({
				access_token: result.token,
				token_type: 'Bearer',
				scope: result.scope,
				created_at: result.createdAt,
			});
		} catch (err) {
			if (err instanceof AppError) {
				return c.json(
					{ error: err.message, error_description: err.errorDescription ?? err.message },
					err.statusCode as 400 | 401,
				);
			}
			throw err;
		}
	}

	// ---------------------------------------------------------------------------
	// grant_type=client_credentials
	// ---------------------------------------------------------------------------

	if (grantType === 'client_credentials') {
		const oauthApp = await env.DB.prepare(
			`SELECT id, client_secret, scopes FROM oauth_applications WHERE client_id = ?1 LIMIT 1`,
		)
			.bind(clientId)
			.first<{ id: string; client_secret: string; scopes: string }>();

		if (!oauthApp) {
			return c.json(
				{ error: 'invalid_client', error_description: 'Unknown client_id' },
				401,
			);
		}

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

		// App-level token (no user, no email notification)
		const { tokenValue, createdAt } = await createAccessToken(oauthApp.id, null, { scopes: scope });

		return c.json({
			access_token: tokenValue,
			token_type: 'Bearer',
			scope,
			created_at: Math.floor(new Date(createdAt).getTime() / 1000),
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

export default app;
