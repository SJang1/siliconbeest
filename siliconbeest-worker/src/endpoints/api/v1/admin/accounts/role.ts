import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../../env';
import { AppError } from '../../../../../middleware/errorHandler';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const VALID_ROLES = ['user', 'moderator', 'admin'];

const app = new Hono<HonoEnv>();

/**
 * POST /api/v1/admin/accounts/:id/role — change a user's role.
 * Body: { role: 'user' | 'moderator' | 'admin' }
 */
app.post('/:id/role', async (c) => {
	const id = c.req.param('id');
	const body = await c.req.json<{ role?: string }>().catch(() => ({}) as { role?: string });
	const role = body.role;

	if (!role || !VALID_ROLES.includes(role)) {
		throw new AppError(422, `Validation failed: role must be one of ${VALID_ROLES.join(', ')}`);
	}

	// Verify account exists
	const account = await c.env.DB.prepare('SELECT id FROM accounts WHERE id = ?1').bind(id).first();
	if (!account) throw new AppError(404, 'Record not found');

	// Verify user exists
	const user = await c.env.DB.prepare('SELECT id, role FROM users WHERE account_id = ?1').bind(id).first();
	if (!user) throw new AppError(404, 'Record not found');

	// Update role
	await c.env.DB.prepare('UPDATE users SET role = ?1, updated_at = ?2 WHERE account_id = ?3')
		.bind(role, new Date().toISOString(), id)
		.run();

	return c.json({ id, role }, 200);
});

export default app;
