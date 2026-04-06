import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../types';
import { sha256 } from '../../../utils/crypto';
import { createOAuthApp } from '../../../services/oauth';
import { getVapidPublicKey } from '../../../utils/vapid';
import { getApplicationByAccessToken } from '../../../services/instance';

const app = new Hono<{ Variables: AppVariables }>();

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

	const oauthApp = await createOAuthApp(clientName, redirectUri, scopes, website);

	return c.json({
		id: oauthApp.id,
		name: oauthApp.name,
		website: oauthApp.website,
		redirect_uri: oauthApp.redirect_uri,
		client_id: oauthApp.client_id,
		client_secret: oauthApp.client_secret,
		vapid_key: await getVapidPublicKey(),
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

	// Look up the token by hash (with legacy plaintext fallback)
	const tokenHash = await sha256(token);
	const appInfo = await getApplicationByAccessToken(tokenHash, token);

	if (!appInfo) {
		return c.json({ error: 'The access token is invalid' }, 401);
	}

	return c.json({
		name: appInfo.name,
		website: appInfo.website ?? null,
		vapid_key: await getVapidPublicKey(),
	});
});

export default app;
