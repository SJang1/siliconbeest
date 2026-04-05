import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';
import { authRequired, adminOnlyRequired as adminRequired } from '../../../../middleware/auth';
import {
	listDomainAllows,
	getDomainAllow,
	createDomainAllow,
	deleteDomainAllow,
} from '../../../../services/admin';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminRequired);

/**
 * GET /api/v1/admin/domain_allows — list allowed domains.
 */
app.get('/', async (c) => {
	const limit = Math.min(parseInt(c.req.query('limit') || '40', 10), 200);
	const results = await listDomainAllows(c.env.DB, limit);
	return c.json(results.map(formatDomainAllow));
});

/**
 * GET /api/v1/admin/domain_allows/:id — fetch single.
 */
app.get('/:id', async (c) => {
	const row = await getDomainAllow(c.env.DB, c.req.param('id'));
	return c.json(formatDomainAllow(row));
});

/**
 * POST /api/v1/admin/domain_allows — create a domain allow entry.
 */
app.post('/', async (c) => {
	const body = await c.req.json<{ domain: string }>();
	if (!body.domain) throw new AppError(422, 'domain is required');

	const row = await createDomainAllow(c.env.DB, body.domain);
	return c.json(formatDomainAllow(row), 200);
});

/**
 * DELETE /api/v1/admin/domain_allows/:id — remove.
 */
app.delete('/:id', async (c) => {
	await deleteDomainAllow(c.env.DB, c.req.param('id'));
	return c.json({}, 200);
});

function formatDomainAllow(row: Record<string, unknown>) {
	return {
		id: row.id as string,
		domain: row.domain as string,
		created_at: row.created_at as string,
	};
}

export default app;
