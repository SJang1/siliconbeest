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
import {
	verifyPasswordForRegistration,
	getOrCreateInternalApp,
	createAccessToken,
	updateSignInTracking,
} from '../../../../services/auth';
import { clearAuthTokenCookie, setAuthTokenCookie } from '../../../../utils/authCookie';
import { getInternalSessionOAuthScopes } from '../../../../../../../packages/shared/permissions';
import {
	createRegistrationSession,
	revokeRegistrationSession,
} from '../../../../services/registration';
import {
	clearRegistrationSessionCookie,
	getRegistrationSessionFromCookie,
	setRegistrationSessionCookie,
} from '../../../../utils/registrationCookie';
import {
	clearLoginPreflightCookie,
	completeLoginPreflight,
	getFailedLoginPreflightReturnTo,
	getLoginPreflightStatus,
	getSafeLoginReturnTo,
	isLoginPreflightSatisfied,
} from '../../../../services/loginPreflight';

const app = new Hono<{ Variables: AppVariables }>();

app.get('/preflight', async (c) => {
	const status = await getLoginPreflightStatus(c.req.header('Cookie'));
	c.header('Cache-Control', 'no-store');
	return c.json(status);
});

app.post('/preflight', async (c) => {
	c.header('Cache-Control', 'no-store');
	const formData = await c.req.formData().catch(() => null);
	const turnstileToken = formData?.get('turnstile_token');
	const returnTo = formData?.get('return_to');
	const result = await completeLoginPreflight(
		c,
		typeof turnstileToken === 'string' ? turnstileToken : '',
	);

	if (result === 'rejected') {
		return c.redirect(
			getFailedLoginPreflightReturnTo(typeof returnTo === 'string' ? returnTo : null),
			303,
		);
	}

	return c.redirect(getSafeLoginReturnTo(typeof returnTo === 'string' ? returnTo : null), 303);
});

app.post('/', async (c) => {
	if (!await isLoginPreflightSatisfied(c.req.header('Cookie'))) {
		return c.json({ error: 'login_preflight_required' }, 403);
	}

	const body = await c.req.json<{ username?: string; email?: string; password?: string }>()
		.catch((): { username?: string; email?: string; password?: string } => ({}));

	// Accept "username" or fall back to legacy "email" field for backwards compatibility
	const identifier = body.username || body.email;
	const { password } = body;

	if (typeof identifier !== 'string' || typeof password !== 'string' || !identifier || !password) {
		return c.json({ error: 'Username and password are required' }, 422);
	}

	const result = await verifyPasswordForRegistration(identifier, password);
	if (!result) {
		return c.json({ error: 'Invalid username or password' }, 401);
	}

	const { user, account } = result;
	if (user.disabled || account.suspended_at || account.memorial) {
		return c.json({ error: 'Invalid username or password' }, 401);
	}

	if (user.registration_state !== 'active' || !user.approved) {
		clearLoginPreflightCookie(c);
		const previousRegistrationToken = getRegistrationSessionFromCookie(c.req.header('Cookie'));
		if (previousRegistrationToken) await revokeRegistrationSession(previousRegistrationToken);
		setRegistrationSessionCookie(c, await createRegistrationSession(user.id));
		clearAuthTokenCookie(c);
		return c.json({
			registration_required: true as const,
			registration_state: user.registration_state === 'active'
				? 'pending_approval' as const
				: user.registration_state,
		});
	}
	if (!user.confirmed_at) {
		return c.json({ error: 'Email not confirmed', error_description: 'Please confirm your email address' }, 403);
	}

	// 2FA challenge
	if (user.otp_enabled) {
		clearLoginPreflightCookie(c);
		const mfaToken = generateToken(64);
		await env.CACHE.put(`mfa:${mfaToken}`, user.id, { expirationTtl: 300 });
		return c.json({ error: 'mfa_required', mfa_token: mfaToken, supported_challenge_types: ['totp'] }, 403);
	}

	// Issue access token (includes login notification email)
	const appRecord = await getOrCreateInternalApp();
	const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || '';
	const userAgent = c.req.header('User-Agent') || '';
	const scopes = getInternalSessionOAuthScopes(user.role);
	const { tokenValue, createdAt } = await createAccessToken(appRecord.id, user.id, {
		ip, userAgent, email: user.email, locale: user.locale, scopes,
	});

	await updateSignInTracking(user.id, ip);

	setAuthTokenCookie(c, tokenValue);
	clearLoginPreflightCookie(c);
	const registrationToken = getRegistrationSessionFromCookie(c.req.header('Cookie'));
	if (registrationToken) await revokeRegistrationSession(registrationToken);
	clearRegistrationSessionCookie(c);

	return c.json({
		access_token: tokenValue,
		token_type: 'Bearer',
		scope: scopes,
		created_at: Math.floor(new Date(createdAt).getTime() / 1000),
	});
});

export default app;
