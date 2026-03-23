import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired, adminOnlyRequired as adminRequired } from '../../../../middleware/auth';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminRequired);

/**
 * GET /api/v1/admin/settings — get all instance settings.
 */
app.get('/', async (c) => {
	const { results } = await c.env.DB.prepare('SELECT * FROM settings ORDER BY key ASC').all();

	const settings: Record<string, string> = {};
	for (const row of results || []) {
		settings[row.key as string] = row.value as string;
	}

	return c.json(settings);
});

/**
 * PATCH /api/v1/admin/settings — update settings (key-value pairs).
 */
app.patch('/', async (c) => {
	const body = await c.req.json<Record<string, string>>();
	const now = new Date().toISOString();

	const statements = Object.entries(body).map(([key, value]) =>
		c.env.DB.prepare(
			`INSERT INTO settings (key, value, updated_at)
			 VALUES (?1, ?2, ?3)
			 ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3`,
		).bind(key, value, now),
	);

	if (statements.length > 0) {
		await c.env.DB.batch(statements);
	}

	// Return the full settings after update
	const { results } = await c.env.DB.prepare('SELECT * FROM settings ORDER BY key ASC').all();
	const settings: Record<string, string> = {};
	for (const row of results || []) {
		settings[row.key as string] = row.value as string;
	}

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
	const now = new Date().toISOString();
	await c.env.DB.prepare(
		`INSERT INTO settings (key, value, updated_at) VALUES ('thumbnail_url', ?1, ?2)
		 ON CONFLICT (key) DO UPDATE SET value = ?1, updated_at = ?2`,
	).bind(url, now).run();

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

	const now = new Date().toISOString();
	await c.env.DB.prepare(
		`INSERT INTO settings (key, value, updated_at) VALUES ('favicon_url', ?1, ?2)
		 ON CONFLICT (key) DO UPDATE SET value = ?1, updated_at = ?2`,
	).bind(url, now).run();

	return c.json({ url });
});

export default app;
