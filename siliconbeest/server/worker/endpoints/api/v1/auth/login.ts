/**
 * Direct login endpoint for the built-in frontend.
 * POST /api/v1/auth/login
 *
 * This is a non-standard convenience endpoint that combines
 * OAuth app creation + authorization + token exchange into one step.
 * Third-party apps should use the standard OAuth 2.0 flow instead.
 *
 * When the user has TOTP 2FA enabled, this endpoint returns an
 * `mfa_required` challenge instead of an access token. The client
 * must then call POST /api/v1/auth/mfa/challenge with the temporary
 * mfa_token and the TOTP code.
 */
import { Hono } from 'hono';
import type { Env, AppVariables } from '../../../../env';
import { generateToken } from '../../../../utils/crypto';
import { verifyTurnstile, getTurnstileSettings } from '../../../../utils/turnstile';
import {
	verifyPassword,
	getOrCreateInternalApp,
	createAccessToken,
	updateSignInTracking,
} from '../../../../services/auth';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.post('/', async (c) => {
	const body = await c.req.json<{ email?: string; password?: string; turnstile_token?: string }>().catch((): { email?: string; password?: string; turnstile_token?: string } => ({}));
	const { email, password } = body;

	if (!email || !password) {
		return c.json({ error: 'Email and password are required' }, 422);
	}

	// Turnstile CAPTCHA verification (if enabled)
	const turnstile = await getTurnstileSettings(c.env.DB, c.env.CACHE);
	if (turnstile.enabled && turnstile.secretKey) {
		if (!body.turnstile_token) {
			return c.json({ error: 'CAPTCHA verification failed. Please try again.' }, 422);
		}
		const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For');
		const valid = await verifyTurnstile(body.turnstile_token, turnstile.secretKey, ip);
		if (!valid) {
			return c.json({ error: 'CAPTCHA verification failed. Please try again.' }, 422);
		}
	}

	// Verify email/password via auth service
	const result = await verifyPassword(c.env.DB, email, password);

	if (!result) {
		return c.json({ error: 'Invalid email or password' }, 401);
	}

	const { user } = result;

	if (!user.approved) {
		return c.json({ error: 'Your account is pending approval' }, 403);
	}

	if (!user.confirmed_at) {
		return c.json({ error: 'Email not confirmed', error_description: 'Please confirm your email address' }, 403);
	}

	// 2FA challenge: if TOTP is enabled, return a temporary mfa_token
	if (user.otp_enabled) {
		const mfaToken = generateToken(64);
		// Store in KV with 5-minute TTL: mfa:<token> → user_id
		await c.env.CACHE.put(`mfa:${mfaToken}`, user.id, { expirationTtl: 300 });

		return c.json({
			error: 'mfa_required',
			mfa_token: mfaToken,
			supported_challenge_types: ['totp'],
		}, 403);
	}

	// No 2FA — issue access token directly
	const appRecord = await getOrCreateInternalApp(c.env.DB);
	const { tokenValue, createdAt } = await createAccessToken(c.env.DB, appRecord.id, user.id);

	// Update sign-in tracking
	const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || '';
	await updateSignInTracking(c.env.DB, user.id, ip);

	return c.json({
		access_token: tokenValue,
		token_type: 'Bearer',
		scope: 'read write follow push',
		created_at: Math.floor(new Date(createdAt).getTime() / 1000),
	});
});

export default app;
