import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { AppError } from '../../../../middleware/errorHandler';
import { authRequired, adminOnlyRequired as adminRequired } from '../../../../middleware/auth';
import {
	listEmailDomainBlocks,
	getEmailDomainBlock,
	createEmailDomainBlock,
	deleteEmailDomainBlock,
} from '../../../../services/admin';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

app.use('*', authRequired, adminRequired);

/**
 * GET /api/v1/admin/email_domain_blocks — list email domain blocks.
 */
app.get('/', async (c) => {
	const limit = Math.min(parseInt(c.req.query('limit') || '40', 10), 200);
	const results = await listEmailDomainBlocks(limit);
	return c.json(results.map(formatEmailDomainBlock));
});

/**
 * GET /api/v1/admin/email_domain_blocks/:id — fetch single.
 */
app.get('/:id', async (c) => {
	const row = await getEmailDomainBlock(c.req.param('id'));
	return c.json(formatEmailDomainBlock(row));
});

/**
 * POST /api/v1/admin/email_domain_blocks — create.
 */
app.post('/', async (c) => {
	const body = await c.req.json<{ domain: string }>();
	if (!body.domain) throw new AppError(422, 'domain is required');

	const row = await createEmailDomainBlock(body.domain);
	return c.json(formatEmailDomainBlock(row), 200);
});

/**
 * DELETE /api/v1/admin/email_domain_blocks/:id — remove.
 */
app.delete('/:id', async (c) => {
	await deleteEmailDomainBlock(c.req.param('id'));
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
