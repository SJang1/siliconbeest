import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { AppError } from '../../../../middleware/errorHandler';
import { generateToken, hashPassword } from '../../../../utils/crypto';
import { sendPasswordReset } from '../../../../services/email';

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

	// Look up user by email (include locale for localised email)
	const user = await c.env.DB.prepare('SELECT id, email, locale FROM users WHERE email = ?1')
		.bind(email)
		.first();

	if (user) {
		const token = generateToken(64);
		const now = new Date().toISOString();

		await c.env.DB.prepare(
			'UPDATE users SET reset_password_token = ?1, reset_password_sent_at = ?2 WHERE id = ?3',
		)
			.bind(token, now, user.id)
			.run();

		// Send email in user's locale (best-effort — failures are logged but do not break the response)
		await sendPasswordReset(c.env, email, token, (user.locale as string) || 'en');
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

	// Find user by reset token
	const user = await c.env.DB.prepare(
		'SELECT id, reset_password_sent_at FROM users WHERE reset_password_token = ?1',
	)
		.bind(token)
		.first();

	if (!user) {
		throw new AppError(422, 'Reset token is invalid or has expired');
	}

	// Check expiry (1 hour)
	const sentAt = user.reset_password_sent_at as string | null;
	if (sentAt) {
		const sentTime = new Date(sentAt).getTime();
		const now = Date.now();
		const oneHour = 60 * 60 * 1000;
		if (now - sentTime > oneHour) {
			throw new AppError(422, 'Reset token is invalid or has expired');
		}
	}

	// Hash and update
	const hashed = await hashPassword(password);
	await c.env.DB.prepare(
		'UPDATE users SET encrypted_password = ?1, reset_password_token = NULL, reset_password_sent_at = NULL, updated_at = ?2 WHERE id = ?3',
	)
		.bind(hashed, new Date().toISOString(), user.id)
		.run();

	return c.json({}, 200);
});

export default app;
