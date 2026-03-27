import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';
import { generateUlid } from '../../../../utils/ulid';
import { authRequired, adminOnlyRequired as adminRequired } from '../../../../middleware/auth';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminRequired);

/**
 * GET /api/v1/admin/rules — list all instance rules.
 */
app.get('/', async (c) => {
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM rules ORDER BY priority ASC, created_at ASC',
	).all();

	return c.json((results || []).map(formatRule));
});

/**
 * GET /api/v1/admin/rules/:id — fetch single rule.
 */
app.get('/:id', async (c) => {
	const id = c.req.param('id');
	const row = await c.env.DB.prepare('SELECT * FROM rules WHERE id = ?1').bind(id).first();
	if (!row) throw new AppError(404, 'Record not found');
	return c.json(formatRule(row));
});

/**
 * POST /api/v1/admin/rules — create a rule.
 */
app.post('/', async (c) => {
	const body = await c.req.json<{
		text: string;
		priority?: number;
	}>();

	if (!body.text) throw new AppError(422, 'text is required');

	const id = generateUlid();
	const now = new Date().toISOString();
	const priority = body.priority ?? 0;

	await c.env.DB.prepare(
		'INSERT INTO rules (id, text, priority, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)',
	)
		.bind(id, body.text, priority, now, now)
		.run();

	const row = await c.env.DB.prepare('SELECT * FROM rules WHERE id = ?1').bind(id).first();
	return c.json(formatRule(row!), 200);
});

/**
 * PUT /api/v1/admin/rules/:id — update a rule.
 */
app.put('/:id', async (c) => {
	const id = c.req.param('id');
	const body = await c.req.json<{
		text?: string;
		priority?: number;
	}>();

	const existing = await c.env.DB.prepare('SELECT * FROM rules WHERE id = ?1').bind(id).first();
	if (!existing) throw new AppError(404, 'Record not found');

	const now = new Date().toISOString();

	await c.env.DB.prepare(
		'UPDATE rules SET text = ?1, priority = ?2, updated_at = ?3 WHERE id = ?4',
	)
		.bind(
			body.text ?? existing.text,
			body.priority ?? existing.priority,
			now,
			id,
		)
		.run();

	const row = await c.env.DB.prepare('SELECT * FROM rules WHERE id = ?1').bind(id).first();
	return c.json(formatRule(row!));
});

/**
 * DELETE /api/v1/admin/rules/:id — remove a rule.
 */
app.delete('/:id', async (c) => {
	const id = c.req.param('id');
	const existing = await c.env.DB.prepare('SELECT * FROM rules WHERE id = ?1').bind(id).first();
	if (!existing) throw new AppError(404, 'Record not found');

	await c.env.DB.prepare('DELETE FROM rules WHERE id = ?1').bind(id).run();
	return c.json({}, 200);
});

function formatRule(row: Record<string, unknown>) {
	return {
		id: row.id as string,
		text: row.text as string,
		priority: (row.priority as number) || 0,
		created_at: row.created_at as string,
		updated_at: (row.updated_at as string) || row.created_at as string,
	};
}

export default app;
