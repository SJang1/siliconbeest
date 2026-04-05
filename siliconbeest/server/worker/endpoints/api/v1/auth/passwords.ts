import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';
import { sendPasswordReset } from '../../../../services/email';
import { createPasswordResetToken, resetPasswordWithToken } from '../../../../services/auth';

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * POST /api/v1/auth/passwords — request a password reset email.
 * Body: { email: string }
 *
 * Always returns 200 to prevent email enumeration.
 */
app.post('/', async (c) => {
	const body = await c.req.json<{ email?: string }>().catch((): { email?: string } => ({}));
	const email = body.email?.trim().toLowerCase();

	if (!email) {
		throw new AppError(422, 'Validation failed: email is required');
	}

	const result = await createPasswordResetToken(c.env.DB, email);

	if (result) {
		// Send email in user's locale (best-effort — failures are logged but do not break the response)
		await sendPasswordReset(c.env, email, result.token, result.locale || 'en');
	}

	// Always return 200 to prevent email enumeration
	return c.json({}, 200);
});

/**
 * POST /api/v1/auth/passwords/reset — reset password using a token.
 * Body: { token: string, password: string }
 */
app.post('/reset', async (c) => {
	const body = await c.req.json<{ token?: string; password?: string }>().catch((): { token?: string; password?: string } => ({}));
	const token = body.token?.trim();
	const password = body.password;

	if (!token || !password) {
		throw new AppError(422, 'Validation failed: token and password are required');
	}

	if (password.length < 8) {
		throw new AppError(422, 'Validation failed: password must be at least 8 characters');
	}

	await resetPasswordWithToken(c.env.DB, token, password);

	return c.json({}, 200);
});

export default app;
