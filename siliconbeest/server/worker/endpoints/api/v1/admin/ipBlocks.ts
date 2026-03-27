import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';
import { generateUlid } from '../../../../utils/ulid';
import { authRequired, adminOnlyRequired as adminRequired } from '../../../../middleware/auth';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminRequired);

/**
 * GET /api/v1/admin/ip_blocks — list IP blocks.
 */
app.get('/', async (c) => {
	const limit = Math.min(parseInt(c.req.query('limit') || '40', 10), 200);
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM ip_blocks ORDER BY id DESC LIMIT ?1',
	)
		.bind(limit)
		.all();

	return c.json((results || []).map(formatIpBlock));
});

/**
 * GET /api/v1/admin/ip_blocks/:id — fetch single.
 */
app.get('/:id', async (c) => {
	const id = c.req.param('id');
	const row = await c.env.DB.prepare('SELECT * FROM ip_blocks WHERE id = ?1').bind(id).first();
	if (!row) throw new AppError(404, 'Record not found');
	return c.json(formatIpBlock(row));
});

/**
 * POST /api/v1/admin/ip_blocks — create an IP block (supports CIDR notation).
 */
app.post('/', async (c) => {
	const body = await c.req.json<{
		ip: string;
		severity: string;
		comment?: string;
		expires_in?: number;
	}>();

	if (!body.ip) throw new AppError(422, 'ip is required');
	if (!body.severity) throw new AppError(422, 'severity is required');

	const id = generateUlid();
	const now = new Date().toISOString();
	const expiresAt = body.expires_in
		? new Date(Date.now() + body.expires_in * 1000).toISOString()
		: null;

	await c.env.DB.prepare(
		`INSERT INTO ip_blocks (id, ip, severity, comment, expires_at, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
	)
		.bind(id, body.ip, body.severity, body.comment || null, expiresAt, now, now)
		.run();

	const row = await c.env.DB.prepare('SELECT * FROM ip_blocks WHERE id = ?1').bind(id).first();
	return c.json(formatIpBlock(row!), 200);
});

/**
 * PUT /api/v1/admin/ip_blocks/:id — update.
 */
app.put('/:id', async (c) => {
	const id = c.req.param('id');
	const body = await c.req.json<{
		ip?: string;
		severity?: string;
		comment?: string;
		expires_in?: number;
	}>();

	const existing = await c.env.DB.prepare('SELECT * FROM ip_blocks WHERE id = ?1').bind(id).first();
	if (!existing) throw new AppError(404, 'Record not found');

	const now = new Date().toISOString();
	const expiresAt = body.expires_in !== undefined
		? (body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null)
		: existing.expires_at;

	await c.env.DB.prepare(
		`UPDATE ip_blocks SET
			ip = ?1,
			severity = ?2,
			comment = ?3,
			expires_at = ?4,
			updated_at = ?5
		WHERE id = ?6`,
	)
		.bind(
			body.ip ?? existing.ip,
			body.severity ?? existing.severity,
			body.comment !== undefined ? body.comment : existing.comment,
			expiresAt,
			now,
			id,
		)
		.run();

	const row = await c.env.DB.prepare('SELECT * FROM ip_blocks WHERE id = ?1').bind(id).first();
	return c.json(formatIpBlock(row!));
});

/**
 * DELETE /api/v1/admin/ip_blocks/:id — remove.
 */
app.delete('/:id', async (c) => {
	const id = c.req.param('id');
	const existing = await c.env.DB.prepare('SELECT * FROM ip_blocks WHERE id = ?1').bind(id).first();
	if (!existing) throw new AppError(404, 'Record not found');

	await c.env.DB.prepare('DELETE FROM ip_blocks WHERE id = ?1').bind(id).run();
	return c.json({}, 200);
});

function formatIpBlock(row: Record<string, unknown>) {
	return {
		id: row.id as string,
		ip: row.ip as string,
		severity: row.severity as string,
		comment: (row.comment as string) || '',
		created_at: row.created_at as string,
		expires_at: (row.expires_at as string) || null,
	};
}

export default app;
