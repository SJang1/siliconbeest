import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../../../types';
import { AppError } from '../../../../../middleware/errorHandler';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * POST /api/v1/admin/reports/:id/assign_to_self — assign report to current admin.
 */
app.post('/:id/assign_to_self', async (c) => {
	const id = c.req.param('id');
	const currentUser = c.get('currentUser')!;

	const row = await env.DB.prepare('SELECT * FROM reports WHERE id = ?1').bind(id).first();
	if (!row) throw new AppError(404, 'Record not found');

	await env.DB.prepare('UPDATE reports SET assigned_account_id = ?1 WHERE id = ?2')
		.bind(currentUser.account_id, id)
		.run();

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
		assigned_account: { id: currentUser.account_id },
		action_taken_by_account: row.action_taken_by_account_id
			? { id: row.action_taken_by_account_id as string }
			: null,
		statuses: [],
		rules: [],
	});
});

/**
 * POST /api/v1/admin/reports/:id/unassign — unassign report.
 */
app.post('/:id/unassign', async (c) => {
	const id = c.req.param('id');

	const row = await env.DB.prepare('SELECT * FROM reports WHERE id = ?1').bind(id).first();
	if (!row) throw new AppError(404, 'Record not found');

	await env.DB.prepare('UPDATE reports SET assigned_account_id = NULL WHERE id = ?1').bind(id).run();

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
		assigned_account: null,
		action_taken_by_account: row.action_taken_by_account_id
			? { id: row.action_taken_by_account_id as string }
			: null,
		statuses: [],
		rules: [],
	});
});

export default app;
