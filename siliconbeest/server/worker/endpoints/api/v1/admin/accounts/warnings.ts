import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../../env';
import { getAccountWarnings } from '../../../../../services/admin';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * GET /api/v1/admin/accounts/:id/warnings — warning history for an account.
 *
 * Returns an array of account_warnings ordered by created_at DESC.
 */
app.get('/:id/warnings', async (c) => {
	const id = c.req.param('id');
	const warnings = await getAccountWarnings(c.env.DB, id);
	return c.json(warnings);
});

export default app;
