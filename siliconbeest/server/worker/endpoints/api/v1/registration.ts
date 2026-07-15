import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppVariables } from '../../../types';
import { AppError } from '../../../middleware/errorHandler';
import { authRequired } from '../../../middleware/auth';
import {
	activateRegistration,
	continueRegistration,
	deletePendingRegistration,
	getRegistrationStatus,
	previewRegistrationInvitation,
	resolveRegistrationSession,
	revokeRegistrationSession,
	startEmailVerification,
	verifyRegistrationCode,
	type ActivatedRegistration,
} from '../../../services/registration';
import {
	createAccessToken,
	getOrCreateInternalApp,
	updateSignInTracking,
} from '../../../services/auth';
import { getInternalSessionOAuthScopes } from '../../../../../../packages/shared/permissions';
import { setAuthTokenCookie } from '../../../utils/authCookie';
import {
	clearRegistrationSessionCookie,
	getRegistrationSessionFromCookie,
} from '../../../utils/registrationCookie';
import { consumeRegistrationCompletionTicket } from '../../../services/registrationCompletion';

type RegistrationContext = Context<{ Variables: AppVariables }>;
const app = new Hono<{ Variables: AppVariables }>();

async function requireRegistrationSession(c: RegistrationContext): Promise<{
	token: string;
	userId: string;
}> {
	const token = getRegistrationSessionFromCookie(c.req.header('Cookie'));
	if (!token) throw new AppError(401, 'Registration session is invalid');
	const userId = await resolveRegistrationSession(token);
	if (!userId) {
		clearRegistrationSessionCookie(c);
		throw new AppError(401, 'Registration session is invalid');
	}
	return { token, userId };
}

async function activeRegistrationResponse(c: RegistrationContext, activation: ActivatedRegistration) {
	const application = await getOrCreateInternalApp();
	const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || '';
	const userAgent = c.req.header('User-Agent') || '';
	const scopes = getInternalSessionOAuthScopes('user');
	const { tokenValue } = await createAccessToken(application.id, activation.userId, {
		ip,
		userAgent,
		scopes,
	});
	await updateSignInTracking(activation.userId, ip);
	setAuthTokenCookie(c, tokenValue);
	const registrationToken = getRegistrationSessionFromCookie(c.req.header('Cookie'));
	if (registrationToken) await revokeRegistrationSession(registrationToken);
	clearRegistrationSessionCookie(c);
	return c.json({
		state: 'active' as const,
		access_token: tokenValue,
		redirect_uri: activation.redirectUri,
		passkey_prompt: true,
	});
}

app.get('/invitations/:token', async (c) => {
	return c.json(await previewRegistrationInvitation(c.req.param('token')));
});

app.post('/completion', authRequired, async (c) => {
	const body = await c.req.json<{ ticket?: string }>().catch((): { ticket?: string } => ({}));
	if (typeof body.ticket !== 'string' || !body.ticket) {
		throw new AppError(422, 'Registration completion ticket is required');
	}
	const currentUser = c.get('currentUser')!;
	const completion = await consumeRegistrationCompletionTicket(body.ticket, currentUser.id);
	return c.json({
		state: 'active' as const,
		redirect_uri: completion.redirectUri,
		passkey_prompt: true as const,
	});
});

app.get('/', async (c) => {
	const { userId } = await requireRegistrationSession(c);
	return c.json(await getRegistrationStatus(userId));
});

app.post('/continue', async (c) => {
	const { userId } = await requireRegistrationSession(c);
	const result = await continueRegistration(userId);
	if ('newlyActivated' in result) return activeRegistrationResponse(c, result);
	return c.json({
		state: result.state,
		email_verification_required: result.email_verification_required,
		email_verification_expires_at: result.email_verification_expires_at,
	});
});

app.post('/verify', async (c) => {
	const { userId } = await requireRegistrationSession(c);
	const body = await c.req.json<{ code?: string }>().catch((): { code?: string } => ({}));
	if (typeof body.code !== 'string' || !body.code) {
		throw new AppError(422, 'Verification code is required');
	}
	return activeRegistrationResponse(c, await verifyRegistrationCode(userId, body.code.trim()));
});

app.post('/resend', async (c) => {
	const { userId } = await requireRegistrationSession(c);
	const current = await getRegistrationStatus(userId);
	if (current.state !== 'email_verification' && current.state !== 'awaiting_confirmation') {
		throw new AppError(409, 'Email verification is not pending');
	}
	const status = await startEmailVerification(userId);
	return c.json({
		state: status.state,
		email_verification_required: status.email_verification_required,
		email_verification_expires_at: status.email_verification_expires_at,
	});
});

app.post('/cancel', async (c) => {
	const { token, userId } = await requireRegistrationSession(c);
	await deletePendingRegistration(userId, undefined, 'cancelled', {
		startCancellationCooldown: true,
	});
	await revokeRegistrationSession(token);
	clearRegistrationSessionCookie(c);
	return c.json({ cancelled: true });
});

app.post('/logout', async (c) => {
	const token = getRegistrationSessionFromCookie(c.req.header('Cookie'));
	if (token) await revokeRegistrationSession(token);
	clearRegistrationSessionCookie(c);
	return c.json({});
});

export default app;
