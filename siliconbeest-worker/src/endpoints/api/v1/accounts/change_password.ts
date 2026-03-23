import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';
import { authRequired } from '../../../../middleware/auth';
import { hashPassword, verifyPassword } from '../../../../utils/crypto';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * POST /api/v1/accounts/change_password — change the authenticated user's password.
 * Body: { current_password: string, new_password: string }
 */
app.post('/change_password', authRequired, async (c) => {
	const currentUser = c.get('currentUser');
	if (!currentUser) throw new AppError(401, 'The access token is invalid');

	const body = await c.req.json<{ current_password?: string; new_password?: string }>().catch(() => ({}) as { current_password?: string; new_password?: string });
	const currentPassword = body.current_password;
	const newPassword = body.new_password;

	if (!currentPassword || !newPassword) {
		throw new AppError(422, 'Validation failed: current_password and new_password are required');
	}

	if (newPassword.length < 8) {
		throw new AppError(422, 'Validation failed: new password must be at least 8 characters');
	}

	// Fetch the current hash
	const user = await c.env.DB.prepare('SELECT encrypted_password FROM users WHERE id = ?1')
		.bind(currentUser.id)
		.first();

	if (!user) throw new AppError(404, 'Record not found');

	// Verify current password
	const valid = await verifyPassword(currentPassword, user.encrypted_password as string);
	if (!valid) {
		throw new AppError(422, 'Current password is incorrect');
	}

	// Hash and save
	const hashed = await hashPassword(newPassword);
	await c.env.DB.prepare('UPDATE users SET encrypted_password = ?1, updated_at = ?2 WHERE id = ?3')
		.bind(hashed, new Date().toISOString(), currentUser.id)
		.run();

	return c.json({}, 200);
});

export default app;
