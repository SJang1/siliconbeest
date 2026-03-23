import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../../env';
import { AppError } from '../../../../../middleware/errorHandler';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * POST /api/v1/admin/reports/:id/resolve — mark a report as resolved.
 */
app.post('/:id/resolve', async (c) => {
	const id = c.req.param('id');
	const currentUser = c.get('currentUser')!;
	const now = new Date().toISOString();

	const row = await c.env.DB.prepare('SELECT * FROM reports WHERE id = ?1').bind(id).first();
	if (!row) throw new AppError(404, 'Record not found');

	await c.env.DB.prepare(
		'UPDATE reports SET action_taken_at = ?1, action_taken_by_account_id = ?2 WHERE id = ?3',
	)
		.bind(now, currentUser.account_id, id)
		.run();

	return c.json({
		id: row.id as string,
		action_taken: true,
		action_taken_at: now,
		category: (row.category as string) || 'other',
		comment: (row.comment as string) || '',
		forwarded: !!(row.forwarded),
		created_at: row.created_at as string,
		updated_at: now,
		account: { id: row.account_id as string },
		target_account: { id: row.target_account_id as string },
		assigned_account: row.assigned_account_id ? { id: row.assigned_account_id as string } : null,
		action_taken_by_account: { id: currentUser.account_id },
		statuses: [],
		rules: [],
	});
});

export default app;
