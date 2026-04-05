import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';
import { authRequired, adminOnlyRequired as adminRequired } from '../../../../middleware/auth';
import {
	listIpBlocks,
	getIpBlock,
	createIpBlock,
	updateIpBlock,
	deleteIpBlock,
} from '../../../../services/admin';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminRequired);

/**
 * GET /api/v1/admin/ip_blocks — list IP blocks.
 */
app.get('/', async (c) => {
	const limit = Math.min(parseInt(c.req.query('limit') || '40', 10), 200);
	const results = await listIpBlocks(c.env.DB, limit);
	return c.json(results.map(formatIpBlock));
});

/**
 * GET /api/v1/admin/ip_blocks/:id — fetch single.
 */
app.get('/:id', async (c) => {
	const row = await getIpBlock(c.env.DB, c.req.param('id'));
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

	const row = await createIpBlock(c.env.DB, body);
	return c.json(formatIpBlock(row), 200);
});

/**
 * PUT /api/v1/admin/ip_blocks/:id — update.
 */
app.put('/:id', async (c) => {
	const body = await c.req.json<{
		ip?: string;
		severity?: string;
		comment?: string;
		expires_in?: number;
	}>();

	const row = await updateIpBlock(c.env.DB, c.req.param('id'), body);
	return c.json(formatIpBlock(row));
});

/**
 * DELETE /api/v1/admin/ip_blocks/:id — remove.
 */
app.delete('/:id', async (c) => {
	await deleteIpBlock(c.env.DB, c.req.param('id'));
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
