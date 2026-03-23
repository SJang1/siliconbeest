import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../env';
import { generateToken } from '../../../utils/crypto';
import { generateUlid } from '../../../utils/ulid';

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
	const website = (body.website as string) ?? null;

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

	const id = generateUlid();
	const clientId = generateToken(43);
	const clientSecret = generateToken(64);
	const now = new Date().toISOString();

	// Take only the first redirect URI for storage (Mastodon compat)
	const redirectUri = redirectUris.split(/\s+/)[0];

	await c.env.DB.prepare(
		`INSERT INTO oauth_applications (id, name, client_id, client_secret, redirect_uri, scopes, website, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
	)
		.bind(id, clientName, clientId, clientSecret, redirectUri, scopes, website, now, now)
		.run();

	return c.json({
		id,
		name: clientName,
		website,
		redirect_uri: redirectUri,
		client_id: clientId,
		client_secret: clientSecret,
		vapid_key: c.env.VAPID_PUBLIC_KEY,
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

	// Look up the token and associated application
	const row = await c.env.DB.prepare(
		`SELECT a.name, a.website, a.scopes
		 FROM oauth_access_tokens t
		 JOIN oauth_applications a ON a.id = t.application_id
		 WHERE t.token = ?1
		   AND t.revoked_at IS NULL
		 LIMIT 1`,
	)
		.bind(token)
		.first();

	if (!row) {
		return c.json({ error: 'The access token is invalid' }, 401);
	}

	return c.json({
		name: row.name,
		website: row.website ?? null,
		vapid_key: c.env.VAPID_PUBLIC_KEY,
	});
});

export default app;
