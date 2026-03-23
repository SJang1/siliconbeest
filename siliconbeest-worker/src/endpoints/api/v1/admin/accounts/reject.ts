import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../../env';
import { AppError } from '../../../../../middleware/errorHandler';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * POST /api/v1/admin/accounts/:id/reject — reject and delete a pending account.
 */
app.post('/:id/reject', async (c) => {
	const id = c.req.param('id');

	// Verify the account exists
	const account = await c.env.DB.prepare('SELECT * FROM accounts WHERE id = ?1').bind(id).first();
	if (!account) throw new AppError(404, 'Record not found');

	// Check that the user is actually pending
	const user = await c.env.DB.prepare('SELECT * FROM users WHERE account_id = ?1').bind(id).first();
	if (!user) throw new AppError(404, 'Record not found');
	if (user.approved) throw new AppError(403, 'This account is not pending approval');

	// Delete the user and account (cascading)
	await c.env.DB.batch([
		c.env.DB.prepare('DELETE FROM users WHERE account_id = ?1').bind(id),
		c.env.DB.prepare('DELETE FROM accounts WHERE id = ?1').bind(id),
	]);

	return c.json({}, 200);
});

export default app;
