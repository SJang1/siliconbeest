import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';
import { generateUlid } from '../../../../utils/ulid';
import { authRequired, adminOnlyRequired as adminRequired } from '../../../../middleware/auth';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminRequired);

/**
 * GET /api/v1/admin/domain_blocks — list domain blocks.
 */
app.get('/', async (c) => {
	const limit = Math.min(parseInt(c.req.query('limit') || '40', 10), 200);
	const { results } = await c.env.DB.prepare(
		'SELECT * FROM domain_blocks ORDER BY id DESC LIMIT ?1',
	)
		.bind(limit)
		.all();

	return c.json((results || []).map(formatDomainBlock));
});

/**
 * GET /api/v1/admin/domain_blocks/:id — fetch single domain block.
 */
app.get('/:id', async (c) => {
	const id = c.req.param('id');
	const row = await c.env.DB.prepare('SELECT * FROM domain_blocks WHERE id = ?1').bind(id).first();
	if (!row) throw new AppError(404, 'Record not found');
	return c.json(formatDomainBlock(row));
});

/**
 * POST /api/v1/admin/domain_blocks — create a domain block.
 */
app.post('/', async (c) => {
	const body = await c.req.json<{
		domain: string;
		severity?: string;
		reject_media?: boolean;
		reject_reports?: boolean;
		private_comment?: string;
		public_comment?: string;
		obfuscate?: boolean;
	}>();

	if (!body.domain) throw new AppError(422, 'domain is required');

	// Check for existing block
	const existing = await c.env.DB.prepare('SELECT id FROM domain_blocks WHERE domain = ?1')
		.bind(body.domain)
		.first();
	if (existing) throw new AppError(422, 'Domain block already exists');

	const id = generateUlid();
	const now = new Date().toISOString();
	const severity = body.severity || 'silence';

	await c.env.DB.prepare(
		`INSERT INTO domain_blocks (id, domain, severity, reject_media, reject_reports, private_comment, public_comment, obfuscate, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
	)
		.bind(
			id,
			body.domain,
			severity,
			body.reject_media ? 1 : 0,
			body.reject_reports ? 1 : 0,
			body.private_comment || null,
			body.public_comment || null,
			body.obfuscate ? 1 : 0,
			now,
			now,
		)
		.run();

	const row = await c.env.DB.prepare('SELECT * FROM domain_blocks WHERE id = ?1').bind(id).first();
	return c.json(formatDomainBlock(row!), 200);
});

/**
 * PUT /api/v1/admin/domain_blocks/:id — update a domain block.
 */
app.put('/:id', async (c) => {
	const id = c.req.param('id');
	const body = await c.req.json<{
		severity?: string;
		reject_media?: boolean;
		reject_reports?: boolean;
		private_comment?: string;
		public_comment?: string;
		obfuscate?: boolean;
	}>();

	const existing = await c.env.DB.prepare('SELECT * FROM domain_blocks WHERE id = ?1').bind(id).first();
	if (!existing) throw new AppError(404, 'Record not found');

	const now = new Date().toISOString();

	await c.env.DB.prepare(
		`UPDATE domain_blocks SET
			severity = ?1,
			reject_media = ?2,
			reject_reports = ?3,
			private_comment = ?4,
			public_comment = ?5,
			obfuscate = ?6,
			updated_at = ?7
		WHERE id = ?8`,
	)
		.bind(
			body.severity ?? existing.severity,
			body.reject_media !== undefined ? (body.reject_media ? 1 : 0) : existing.reject_media,
			body.reject_reports !== undefined ? (body.reject_reports ? 1 : 0) : existing.reject_reports,
			body.private_comment !== undefined ? body.private_comment : existing.private_comment,
			body.public_comment !== undefined ? body.public_comment : existing.public_comment,
			body.obfuscate !== undefined ? (body.obfuscate ? 1 : 0) : existing.obfuscate,
			now,
			id,
		)
		.run();

	const row = await c.env.DB.prepare('SELECT * FROM domain_blocks WHERE id = ?1').bind(id).first();
	return c.json(formatDomainBlock(row!));
});

/**
 * DELETE /api/v1/admin/domain_blocks/:id — remove a domain block.
 */
app.delete('/:id', async (c) => {
	const id = c.req.param('id');
	const existing = await c.env.DB.prepare('SELECT * FROM domain_blocks WHERE id = ?1').bind(id).first();
	if (!existing) throw new AppError(404, 'Record not found');

	await c.env.DB.prepare('DELETE FROM domain_blocks WHERE id = ?1').bind(id).run();
	return c.json({}, 200);
});

function formatDomainBlock(row: Record<string, unknown>) {
	return {
		id: row.id as string,
		domain: row.domain as string,
		severity: (row.severity as string) || 'silence',
		reject_media: !!(row.reject_media),
		reject_reports: !!(row.reject_reports),
		private_comment: (row.private_comment as string) || null,
		public_comment: (row.public_comment as string) || null,
		obfuscate: !!(row.obfuscate),
		created_at: row.created_at as string,
	};
}

export default app;
