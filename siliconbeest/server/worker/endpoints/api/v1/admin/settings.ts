import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { authRequired, adminOnlyRequired as adminRequired } from '../../../../middleware/auth';
import { getAllSettings, setSettings } from '../../../../services/instance';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminRequired);

/**
 * GET /api/v1/admin/settings — get all instance settings.
 */
app.get('/', async (c) => {
	const settings = await getAllSettings();
	return c.json(settings);
});

/**
 * PATCH /api/v1/admin/settings — update settings (key-value pairs).
 */
app.patch('/', async (c) => {
	const body = await c.req.json<Record<string, string>>();

	// accent_color drives the Deck UI for every visitor — reject anything
	// that is not a #rrggbb hex so a typo can't break the client-side parser.
	if (body.accent_color !== undefined && body.accent_color !== '' && !/^#[0-9a-fA-F]{6}$/.test(body.accent_color)) {
		return c.json({ error: 'accent_color must be a #rrggbb hex color' }, 422);
	}

	await setSettings(body);

	// Return the full settings after update
	const settings = await getAllSettings();
	return c.json(settings);
});

/**
 * POST /api/v1/admin/settings/thumbnail — upload instance thumbnail
 */
app.post('/thumbnail', async (c) => {
	const formData = await c.req.formData();
	const file = formData.get('file') as File | null;
	if (!file) return c.json({ error: 'file is required' }, 422);

	const buffer = await file.arrayBuffer();
	await env.MEDIA_BUCKET.put('instance/thumbnail.png', buffer, {
		httpMetadata: { contentType: file.type || 'image/png' },
	});

	const domain = env.INSTANCE_DOMAIN;
	const url = `https://${domain}/thumbnail.png`;

	// Save both keys: site_logo_url is what the admin UI edits, while
	// thumbnail_url is kept for older deployments that may already read it.
	await setSettings({
		site_logo_url: url,
		thumbnail_url: url,
	});

	return c.json({ url });
});

/**
 * POST /api/v1/admin/settings/favicon — upload instance favicon
 */
app.post('/favicon', async (c) => {
	const formData = await c.req.formData();
	const file = formData.get('file') as File | null;
	if (!file) return c.json({ error: 'file is required' }, 422);

	const buffer = await file.arrayBuffer();
	// Store as both favicon.ico and the original format
	await env.MEDIA_BUCKET.put('instance/favicon.ico', buffer, {
		httpMetadata: { contentType: file.type || 'image/x-icon' },
	});

	const domain = env.INSTANCE_DOMAIN;
	const url = `https://${domain}/favicon.ico`;

	// Save both keys: site_favicon_url is what the admin UI edits, while
	// favicon_url is kept for older deployments that may already read it.
	await setSettings({
		site_favicon_url: url,
		favicon_url: url,
	});

	return c.json({ url });
});

export default app;
