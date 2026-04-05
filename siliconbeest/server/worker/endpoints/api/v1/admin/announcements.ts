import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';
import { generateUlid } from '../../../../utils/ulid';
import { authRequired, adminRequired } from '../../../../middleware/auth';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminRequired);

/**
 * GET /api/v1/admin/announcements — list all announcements.
 */
app.get('/', async (c) => {
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM announcements ORDER BY created_at DESC',
	).all();

	return c.json((results || []).map(formatAnnouncement));
});

/**
 * GET /api/v1/admin/announcements/:id — fetch single.
 */
app.get('/:id', async (c) => {
	const id = c.req.param('id');
	const row = await c.env.DB.prepare('SELECT * FROM announcements WHERE id = ?1').bind(id).first();
	if (!row) throw new AppError(404, 'Record not found');
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

	const id = generateUlid();
	const now = new Date().toISOString();
	const publishedAt = body.published !== false ? now : null;

	await c.env.DB.prepare(
		`INSERT INTO announcements (id, text, published_at, starts_at, ends_at, all_day, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
	)
		.bind(
			id,
			body.text,
			publishedAt,
			body.starts_at || null,
			body.ends_at || null,
			body.all_day ? 1 : 0,
			now,
			now,
		)
		.run();

	const row = await c.env.DB.prepare('SELECT * FROM announcements WHERE id = ?1').bind(id).first();
	return c.json(formatAnnouncement(row!), 200);
});

/**
 * PUT /api/v1/admin/announcements/:id — update an announcement.
 */
app.put('/:id', async (c) => {
	const id = c.req.param('id');
	const body = await c.req.json<{
		text?: string;
		published?: boolean;
		starts_at?: string;
		ends_at?: string;
		all_day?: boolean;
	}>();

	const existing = await c.env.DB.prepare('SELECT * FROM announcements WHERE id = ?1').bind(id).first();
	if (!existing) throw new AppError(404, 'Record not found');

	const now = new Date().toISOString();
	let publishedAt = existing.published_at;
	if (body.published === true && !existing.published_at) {
		publishedAt = now;
	} else if (body.published === false) {
		publishedAt = null;
	}

	await c.env.DB.prepare(
		`UPDATE announcements SET
			text = ?1,
			published_at = ?2,
			starts_at = ?3,
			ends_at = ?4,
			all_day = ?5,
			updated_at = ?6
		WHERE id = ?7`,
	)
		.bind(
			body.text ?? existing.text,
			publishedAt,
			body.starts_at !== undefined ? body.starts_at : existing.starts_at,
			body.ends_at !== undefined ? body.ends_at : existing.ends_at,
			body.all_day !== undefined ? (body.all_day ? 1 : 0) : existing.all_day,
			now,
			id,
		)
		.run();

	const row = await c.env.DB.prepare('SELECT * FROM announcements WHERE id = ?1').bind(id).first();
	return c.json(formatAnnouncement(row!));
});

/**
 * DELETE /api/v1/admin/announcements/:id — remove.
 */
app.delete('/:id', async (c) => {
	const id = c.req.param('id');
	const existing = await c.env.DB.prepare('SELECT * FROM announcements WHERE id = ?1').bind(id).first();
	if (!existing) throw new AppError(404, 'Record not found');

	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM announcement_dismissals WHERE announcement_id = ?1').bind(id),
		c.env.DB.prepare('DELETE FROM announcements WHERE id = ?1').bind(id),
	]);
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
