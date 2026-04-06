/**
 * Password reset endpoints.
 * POST /  — request reset email (requires username + email)
 * POST /reset — reset password using token
 */
import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { AppError } from '../../../../middleware/errorHandler';
import { sendPasswordReset } from '../../../../services/email';
import { createPasswordResetToken, resetPasswordWithToken } from '../../../../services/auth';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * POST /api/v1/auth/passwords — request a password reset email.
 * Body: { username: string, email: string }
 * Both must match. Always returns 200 to prevent enumeration.
 */
app.post('/', async (c) => {
	const body = await c.req.json<{ username?: string; email?: string }>()
		.catch((): { username?: string; email?: string } => ({}));
	const username = body.username?.trim().toLowerCase();
	const email = body.email?.trim().toLowerCase();

	if (!username || !email) {
		throw new AppError(422, 'Validation failed: username and email are required');
	}

	const result = await createPasswordResetToken(username, email);

	if (result) {
		await sendPasswordReset(email, result.token, result.locale || 'en');
	}

	// Always return 200 to prevent enumeration
	return c.json({}, 200);
});

/**
 * POST /api/v1/auth/passwords/reset — reset password using a token.
 * Body: { token: string, password: string }
 */
app.post('/reset', async (c) => {
	const body = await c.req.json<{ token?: string; password?: string }>()
		.catch((): { token?: string; password?: string } => ({}));
	const token = body.token?.trim();
	const password = body.password;

	if (!token || !password) {
		throw new AppError(422, 'Validation failed: token and password are required');
	}

	if (password.length < 8) {
		throw new AppError(422, 'Validation failed: password must be at least 8 characters');
	}

	await resetPasswordWithToken(token, password);

	return c.json({}, 200);
});

export default app;
