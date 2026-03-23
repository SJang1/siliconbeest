import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { authRequired, adminRequired } from '../../../../middleware/auth';

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

export default app;
