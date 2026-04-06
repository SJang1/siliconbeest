import { Hono } from 'hono';
import type { AppVariables } from '../../../../../types';
import { getAccountWarnings } from '../../../../../services/admin';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * GET /api/v1/admin/accounts/:id/warnings — warning history for an account.
 *
 * Returns an array of account_warnings ordered by created_at DESC.
 */
app.get('/:id/warnings', async (c) => {
	const id = c.req.param('id');
	const warnings = await getAccountWarnings(id);
	return c.json(warnings);
});

export default app;
