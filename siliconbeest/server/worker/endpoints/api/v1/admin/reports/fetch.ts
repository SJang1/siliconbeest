import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../../env';
import { AppError } from '../../../../../middleware/errorHandler';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * GET /api/v1/admin/reports/:id — single report details.
 */
app.get('/:id', async (c) => {
	const id = c.req.param('id');

	const row = await c.env.DB.prepare('SELECT * FROM reports WHERE id = ?1').bind(id).first();
	if (!row) throw new AppError(404, 'Record not found');

	// Fetch associated status IDs
	const { results: statusRows } = await c.env.DB.prepare(
		'SELECT status_id FROM report_statuses WHERE report_id = ?1',
	)
		.bind(id)
		.all();

	// Fetch associated rule IDs
	const { results: ruleRows } = await c.env.DB.prepare(
		'SELECT rule_id FROM report_rules WHERE report_id = ?1',
	)
		.bind(id)
		.all();

	return c.json({
		id: row.id as string,
		action_taken: !!(row.action_taken_at),
		action_taken_at: (row.action_taken_at as string) || null,
		category: (row.category as string) || 'other',
		comment: (row.comment as string) || '',
		forwarded: !!(row.forwarded),
		created_at: row.created_at as string,
		updated_at: (row.updated_at as string) || row.created_at as string,
		account: { id: row.account_id as string },
		target_account: { id: row.target_account_id as string },
		assigned_account: row.assigned_account_id ? { id: row.assigned_account_id as string } : null,
		action_taken_by_account: row.action_taken_by_account_id
			? { id: row.action_taken_by_account_id as string }
			: null,
		statuses: (statusRows || []).map((s) => ({ id: s.status_id as string })),
		rules: (ruleRows || []).map((r) => ({ id: r.rule_id as string })),
	});
});

export default app;
