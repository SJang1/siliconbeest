import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../../env';
import { AppError } from '../../../../../middleware/errorHandler';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * GET /api/v1/admin/accounts/:id/warnings — warning history for an account.
 *
 * Returns an array of account_warnings ordered by created_at DESC.
 */
app.get('/:id/warnings', async (c) => {
	const id = c.req.param('id');

	// Verify the target account exists
	const account = await c.env.DB.prepare('SELECT id FROM accounts WHERE id = ?1').bind(id).first();
	if (!account) throw new AppError(404, 'Record not found');

	const { results } = await c.env.DB.prepare(
		'SELECT id, action, text, created_at, report_id FROM account_warnings WHERE target_account_id = ?1 ORDER BY created_at DESC',
	)
		.bind(id)
		.all();

	const warnings = (results || []).map((row) => ({
		id: row.id as string,
		action: row.action as string,
		text: (row.text as string) || '',
		created_at: row.created_at as string,
		report_id: (row.report_id as string) || null,
	}));

	return c.json(warnings);
});

export default app;
