import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';
import { authRequired, adminRequired } from '../../../../middleware/auth';
import {
	listAnnouncements,
	getAnnouncement,
	createAnnouncement,
	updateAnnouncement,
	deleteAnnouncement,
} from '../../../../services/admin';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminRequired);

/**
 * GET /api/v1/admin/announcements — list all announcements.
 */
app.get('/', async (c) => {
	const results = await listAnnouncements(c.env.DB);
	return c.json(results.map(formatAnnouncement));
});

/**
 * GET /api/v1/admin/announcements/:id — fetch single.
 */
app.get('/:id', async (c) => {
	const row = await getAnnouncement(c.env.DB, c.req.param('id'));
	return c.json(formatAnnouncement(row));
});

/**
 * POST /api/v1/admin/announcements — create an announcement.
 */
app.post('/', async (c) => {
	const body = await c.req.json<{
		text: string;
		published?: boolean;
		starts_at?: string;
		ends_at?: string;
		all_day?: boolean;
	}>();

	if (!body.text) throw new AppError(422, 'text is required');

	const row = await createAnnouncement(c.env.DB, body);
	return c.json(formatAnnouncement(row), 200);
});

/**
 * PUT /api/v1/admin/announcements/:id — update an announcement.
 */
app.put('/:id', async (c) => {
	const body = await c.req.json<{
		text?: string;
		published?: boolean;
		starts_at?: string;
		ends_at?: string;
		all_day?: boolean;
	}>();

	const row = await updateAnnouncement(c.env.DB, c.req.param('id'), body);
	return c.json(formatAnnouncement(row));
});

/**
 * DELETE /api/v1/admin/announcements/:id — remove.
 */
app.delete('/:id', async (c) => {
	await deleteAnnouncement(c.env.DB, c.req.param('id'));
	return c.json({}, 200);
});

function formatAnnouncement(row: Record<string, unknown>) {
	return {
		id: row.id as string,
		text: row.text as string,
		published: !!(row.published_at),
		published_at: (row.published_at as string) || null,
		starts_at: (row.starts_at as string) || null,
		ends_at: (row.ends_at as string) || null,
		all_day: !!(row.all_day),
		created_at: row.created_at as string,
		updated_at: (row.updated_at as string) || row.created_at as string,
		mentions: [],
		statuses: [],
		tags: [],
		emojis: [],
		reactions: [],
	};
}

export default app;
