/**
 * Direct login endpoint for the built-in frontend.
 * POST /api/v1/auth/login
 *
 * Accepts either username or email as the identifier.
 */
import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { AppVariables } from '../../../../types';
import { generateToken } from '../../../../utils/crypto';
import { verifyTurnstile, getTurnstileSettings } from '../../../../utils/turnstile';
import {
	verifyPasswordByUsernameOrEmail,
	getOrCreateInternalApp,
	createAccessToken,
	updateSignInTracking,
} from '../../../../services/auth';

const app = new Hono<{ Variables: AppVariables }>();

app.post('/', async (c) => {
	const body = await c.req.json<{ username?: string; email?: string; password?: string; turnstile_token?: string }>()
		.catch((): { username?: string; email?: string; password?: string; turnstile_token?: string } => ({}));

	// Accept "username" or fall back to legacy "email" field for backwards compatibility
	const identifier = body.username || body.email;
	const { password } = body;

	if (!identifier || !password) {
		return c.json({ error: 'Username and password are required' }, 422);
	}

	// Turnstile CAPTCHA verification (if enabled)
	const turnstile = await getTurnstileSettings();
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

	const result = await verifyPasswordByUsernameOrEmail(identifier, password);
	if (!result) {
		return c.json({ error: 'Invalid username or password' }, 401);
	}

	const { user } = result;

	if (!user.approved) {
		return c.json({ error: 'Your account is pending approval' }, 403);
	}
	if (!user.confirmed_at) {
		return c.json({ error: 'Email not confirmed', error_description: 'Please confirm your email address' }, 403);
	}

	// 2FA challenge
	if (user.otp_enabled) {
		const mfaToken = generateToken(64);
		await env.CACHE.put(`mfa:${mfaToken}`, user.id, { expirationTtl: 300 });
		return c.json({ error: 'mfa_required', mfa_token: mfaToken, supported_challenge_types: ['totp'] }, 403);
	}

	// Issue access token (includes login notification email)
	const appRecord = await getOrCreateInternalApp();
	const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || '';
	const userAgent = c.req.header('User-Agent') || '';
	const { tokenValue, createdAt } = await createAccessToken(appRecord.id, user.id, {
		ip, userAgent, email: user.email, locale: user.locale,
	});

	await updateSignInTracking(user.id, ip);

	return c.json({
		access_token: tokenValue,
		token_type: 'Bearer',
		scope: 'read write follow push',
		created_at: Math.floor(new Date(createdAt).getTime() / 1000),
	});
});

export default app;
