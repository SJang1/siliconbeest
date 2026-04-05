import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../env';
import { sha256 } from '../../../utils/crypto';
import { createOAuthApp } from '../../../services/oauth';
import { getVapidPublicKey } from '../../../utils/vapid';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// POST /api/v1/apps — register an OAuth application
app.post('/', async (c) => {
	let body: Record<string, any>;

	const contentType = c.req.header('Content-Type') ?? '';
	if (contentType.includes('application/json')) {
		body = await c.req.json();
	} else {
		body = (await c.req.parseBody()) as Record<string, any>;
	}

	const clientName = body.client_name as string | undefined;
	const redirectUris = body.redirect_uris as string | undefined;
	const scopes = (body.scopes as string) ?? 'read';
	const website = (body.website as string) ?? undefined;

	if (!clientName) {
		return c.json(
			{ error: 'Validation failed', error_description: 'client_name is required' },
			422,
		);
	}

	if (!redirectUris) {
		return c.json(
			{ error: 'Validation failed', error_description: 'redirect_uris is required' },
			422,
		);
	}

	// Take only the first redirect URI for storage (Mastodon compat)
	const redirectUri = redirectUris.split(/\s+/)[0];

	const oauthApp = await createOAuthApp(c.env.DB, clientName, redirectUri, scopes, website);

	return c.json({
		id: oauthApp.id,
		name: oauthApp.name,
		website: oauthApp.website,
		redirect_uri: oauthApp.redirect_uri,
		client_id: oauthApp.client_id,
		client_secret: oauthApp.client_secret,
		vapid_key: await getVapidPublicKey(c.env.DB),
	});
});

// GET /api/v1/apps/verify_credentials — verify an app token
app.get('/verify_credentials', async (c) => {
	const authHeader = c.req.header('Authorization') ?? '';
	const parts = authHeader.split(' ');
	if (parts.length !== 2 || parts[0] !== 'Bearer') {
		return c.json({ error: 'The access token is invalid' }, 401);
	}
	const token = parts[1];

	// Look up the token by hash
	const tokenHash = await sha256(token);

	let row = await c.env.DB.prepare(
		`SELECT a.name, a.website, a.scopes
		 FROM oauth_access_tokens t
		 JOIN oauth_applications a ON a.id = t.application_id
		 WHERE t.token_hash = ?1
		   AND t.revoked_at IS NULL
		 LIMIT 1`,
	)
		.bind(tokenHash)
		.first();

	if (!row) {
		// Fallback for legacy plaintext tokens
		row = await c.env.DB.prepare(
			`SELECT a.name, a.website, a.scopes
			 FROM oauth_access_tokens t
			 JOIN oauth_applications a ON a.id = t.application_id
			 WHERE t.token = ?1
			   AND t.revoked_at IS NULL
			 LIMIT 1`,
		)
			.bind(token)
			.first();
	}

	if (!row) {
		return c.json({ error: 'The access token is invalid' }, 401);
	}

	return c.json({
		name: row.name,
		website: row.website ?? null,
		vapid_key: await getVapidPublicKey(c.env.DB),
	});
});

export default app;
