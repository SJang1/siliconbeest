import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';
import { generateUlid } from '../../../../utils/ulid';
import { authRequired, adminRequired } from '../../../../middleware/auth';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminRequired);

/**
 * GET /api/v1/admin/email_domain_blocks — list email domain blocks.
 */
app.get('/', async (c) => {
	const limit = Math.min(parseInt(c.req.query('limit') || '40', 10), 200);
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM email_domain_blocks ORDER BY id DESC LIMIT ?1',
	)
		.bind(limit)
		.all();

	return c.json((results || []).map(formatEmailDomainBlock));
});

/**
 * GET /api/v1/admin/email_domain_blocks/:id — fetch single.
 */
app.get('/:id', async (c) => {
	const id = c.req.param('id');
	const row = await c.env.DB.prepare('SELECT * FROM email_domain_blocks WHERE id = ?1').bind(id).first();
	if (!row) throw new AppError(404, 'Record not found');
	return c.json(formatEmailDomainBlock(row));
});

/**
 * POST /api/v1/admin/email_domain_blocks — create.
 */
app.post('/', async (c) => {
	const body = await c.req.json<{ domain: string }>();
	if (!body.domain) throw new AppError(422, 'domain is required');

	const existing = await c.env.DB.prepare('SELECT id FROM email_domain_blocks WHERE domain = ?1')
		.bind(body.domain)
		.first();
	if (existing) throw new AppError(422, 'Email domain block already exists');

	const id = generateUlid();
	const now = new Date().toISOString();

	await c.env.DB.prepare(
		'INSERT INTO email_domain_blocks (id, domain, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)',
	)
		.bind(id, body.domain, now, now)
		.run();

	const row = await c.env.DB.prepare('SELECT * FROM email_domain_blocks WHERE id = ?1').bind(id).first();
	return c.json(formatEmailDomainBlock(row!), 200);
});

/**
 * DELETE /api/v1/admin/email_domain_blocks/:id — remove.
 */
app.delete('/:id', async (c) => {
	const id = c.req.param('id');
	const existing = await c.env.DB.prepare('SELECT * FROM email_domain_blocks WHERE id = ?1').bind(id).first();
	if (!existing) throw new AppError(404, 'Record not found');

	await c.env.DB.prepare('DELETE FROM email_domain_blocks WHERE id = ?1').bind(id).run();
	return c.json({}, 200);
});

function formatEmailDomainBlock(row: Record<string, unknown>) {
	return {
		id: row.id as string,
		domain: row.domain as string,
		created_at: row.created_at as string,
		history: [],
	};
}

export default app;
