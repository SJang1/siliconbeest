import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { AppError } from '../../../../middleware/errorHandler';
import { authRequired } from '../../../../middleware/auth';
import { changePassword } from '../../../../services/auth';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * POST /api/v1/accounts/change_password — change the authenticated user's password.
 * Body: { current_password: string, new_password: string }
 *
 * On success: sends notification email + revokes all other sessions.
 */
app.post('/change_password', authRequired, async (c) => {
	const currentUser = c.get('currentUser');
	if (!currentUser) throw new AppError(401, 'The access token is invalid');

	const body = await c.req.json<{ current_password?: string; new_password?: string }>()
		.catch((): { current_password?: string; new_password?: string } => ({}));
	const currentPassword = body.current_password;
	const newPassword = body.new_password;

	if (!currentPassword || !newPassword) {
		throw new AppError(422, 'Validation failed: current_password and new_password are required');
	}

	if (newPassword.length < 8) {
		throw new AppError(422, 'Validation failed: new password must be at least 8 characters');
	}

	const currentTokenId = c.get('tokenId');

	await changePassword(currentUser.id, currentPassword, newPassword, {
		currentTokenId: currentTokenId ?? undefined,
		email: currentUser.email,
	});

	return c.json({}, 200);
});

export default app;
