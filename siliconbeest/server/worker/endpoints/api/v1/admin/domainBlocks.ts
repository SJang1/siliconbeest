import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';
import { authRequired, adminOnlyRequired as adminRequired } from '../../../../middleware/auth';
import {
	listDomainBlocks,
	getDomainBlock,
	createDomainBlock,
	updateDomainBlock,
	deleteDomainBlock,
} from '../../../../services/admin';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminRequired);

/**
 * GET /api/v1/admin/domain_blocks — list domain blocks.
 */
app.get('/', async (c) => {
	const limit = Math.min(parseInt(c.req.query('limit') || '40', 10), 200);
	const results = await listDomainBlocks(c.env.DB, limit);
	return c.json(results.map(formatDomainBlock));
});

/**
 * GET /api/v1/admin/domain_blocks/:id — fetch single domain block.
 */
app.get('/:id', async (c) => {
	const row = await getDomainBlock(c.env.DB, c.req.param('id'));
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

	const row = await createDomainBlock(c.env.DB, body);

	// Invalidate domain block cache
	await c.env.CACHE.delete(`domblk:${body.domain.toLowerCase()}`);

	return c.json(formatDomainBlock(row), 200);
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

	const { row, domain } = await updateDomainBlock(c.env.DB, id, body);

	// Invalidate domain block cache
	await c.env.CACHE.delete(`domblk:${domain.toLowerCase()}`);

	return c.json(formatDomainBlock(row));
});

/**
 * DELETE /api/v1/admin/domain_blocks/:id — remove a domain block.
 */
app.delete('/:id', async (c) => {
	const domain = await deleteDomainBlock(c.env.DB, c.req.param('id'));
	// Invalidate domain block cache
	await c.env.CACHE.delete(`domblk:${domain.toLowerCase()}`);
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
