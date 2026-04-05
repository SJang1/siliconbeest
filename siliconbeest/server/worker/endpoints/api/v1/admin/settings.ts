import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired, adminOnlyRequired as adminRequired } from '../../../../middleware/auth';
import { getAllSettings, setSettings, setSetting } from '../../../../services/instance';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminRequired);

/**
 * GET /api/v1/admin/settings — get all instance settings.
 */
app.get('/', async (c) => {
	const settings = await getAllSettings(c.env.DB);
	return c.json(settings);
});

/**
 * PATCH /api/v1/admin/settings — update settings (key-value pairs).
 */
app.patch('/', async (c) => {
	const body = await c.req.json<Record<string, string>>();
	await setSettings(c.env.DB, body);

	// Return the full settings after update
	const settings = await getAllSettings(c.env.DB);
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
	await c.env.MEDIA_BUCKET.put('instance/thumbnail.png', buffer, {
		httpMetadata: { contentType: file.type || 'image/png' },
	});

	const domain = c.env.INSTANCE_DOMAIN;
	const url = `https://${domain}/thumbnail.png`;

	// Also save in settings
	await setSetting(c.env.DB, 'thumbnail_url', url);

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
	await c.env.MEDIA_BUCKET.put('instance/favicon.ico', buffer, {
		httpMetadata: { contentType: file.type || 'image/x-icon' },
	});

	const domain = c.env.INSTANCE_DOMAIN;
	const url = `https://${domain}/favicon.ico`;

	await setSetting(c.env.DB, 'favicon_url', url);

	return c.json({ url });
});

export default app;
