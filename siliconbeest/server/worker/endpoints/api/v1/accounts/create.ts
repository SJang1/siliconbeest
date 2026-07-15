import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import type { RegistrationDesign, RegistrationState } from '../../../../types/db';
import type { AppVariables } from '../../../../types';
import { AppError } from '../../../../middleware/errorHandler';
import { createDefaultImages } from '../../../../utils/defaultImages';
import { notifyAdminsPendingUser } from '../../../../services/email';
import { verifyTurnstile, getTurnstileSettings } from '../../../../utils/turnstile';
import { sanitizeLocale } from '../../../../utils/locales';
import { registerUser, validateRegistrationCredentials } from '../../../../services/auth';
import { isEmailDomainBlocked } from '../../../../services/instance';
import {
	assertRegistrationCancellationCooldown,
	consumeRegistrationInvitation,
	createRegistrationSession,
	deletePendingRegistration,
	getRegistrationMode,
	initializeRegistration,
	previewRegistrationInvitation,
	revokeRegistrationSession,
	restoreRegistrationInvitation,
	type RegistrationInvitePreview,
} from '../../../../services/registration';
import {
	getRegistrationSessionFromCookie,
	setRegistrationSessionCookie,
} from '../../../../utils/registrationCookie';
import { clearAuthTokenCookie } from '../../../../utils/authCookie';

type HonoEnv = { Variables: AppVariables };

interface RegistrationRequest {
	username?: string;
	email?: string;
	password?: string;
	agreement?: boolean;
	locale?: string;
	reason?: string;
	turnstile_token?: string;
	invite_token?: string;
	redirect_uri?: string;
	design?: RegistrationDesign;
}

function sanitizeReason(value: string | undefined): string | null {
	if (!value) return null;
	return value
		.replace(/<[^>]*>?/g, '')
		.replace(/&[a-zA-Z0-9#]+;/g, '')
		.trim()
		.slice(0, 1000) || null;
}

const app = new Hono<HonoEnv>();

app.post('/', async (c) => {
	const body = await c.req.json<RegistrationRequest>()
		.catch((): RegistrationRequest => ({}));
	if (typeof body.username !== 'string'
		|| typeof body.email !== 'string'
		|| typeof body.password !== 'string'
		|| !body.username.trim()
		|| !body.email.trim()
		|| !body.password) {
		throw new AppError(422, 'Validation failed', 'Missing required fields');
	}
	if (body.agreement !== true) {
		throw new AppError(422, 'Validation failed', 'Agreement must be accepted');
	}
	if (body.invite_token !== undefined && typeof body.invite_token !== 'string') {
		throw new AppError(422, 'Validation failed', 'invite_token must be a string');
	}
	if ((body.reason !== undefined && typeof body.reason !== 'string')
		|| (body.locale !== undefined && typeof body.locale !== 'string')
		|| (body.turnstile_token !== undefined && typeof body.turnstile_token !== 'string')
		|| (body.redirect_uri !== undefined && typeof body.redirect_uri !== 'string')
		|| (body.design !== undefined
			&& body.design !== 'default'
			&& body.design !== 'aurora'
			&& body.design !== 'old')) {
		throw new AppError(422, 'Validation failed', 'Optional registration fields must be strings');
	}

	const email = body.email.trim().toLowerCase();
	const username = body.username.trim();
	const emailDomain = email.split('@')[1];
	if (emailDomain && await isEmailDomainBlocked(emailDomain)) {
		throw new AppError(422, 'Validation failed', 'Email domain is not allowed for registration');
	}

	const turnstile = await getTurnstileSettings();
	if (turnstile.enabled && turnstile.secretKey) {
		if (!body.turnstile_token) {
			throw new AppError(422, 'Validation failed', 'CAPTCHA verification failed. Please try again.');
		}
		const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For');
		if (!await verifyTurnstile(body.turnstile_token, turnstile.secretKey, ip)) {
			throw new AppError(422, 'Validation failed', 'CAPTCHA verification failed. Please try again.');
		}
	}

	const registrationMode = await getRegistrationMode();
	if (registrationMode === 'closed') {
		throw new AppError(403, 'Registrations are currently closed');
	}
	const reason = sanitizeReason(body.reason);
	const inviteToken = body.invite_token?.trim() || null;
	if (registrationMode === 'referral' && !inviteToken) {
		throw new AppError(403, 'A valid invitation is required');
	}
	if (registrationMode === 'approval' && !inviteToken && !reason) {
		throw new AppError(422, 'Validation failed', 'A registration reason is required');
	}

	// Keep account-existence checks behind the invitation gate. In referral
	// mode an arbitrary non-empty token must not turn this endpoint into an
	// email or username enumeration oracle. The later consume call repeats the
	// availability check and performs the atomic debit.
	if (inviteToken) await previewRegistrationInvitation(inviteToken);
	await assertRegistrationCancellationCooldown(email);

	// Reject invalid or already-taken credentials before touching the finite
	// invitation-use ledger. registerUser repeats this check at insertion time.
	await validateRegistrationCredentials(email, body.password, username);

	let invitation: RegistrationInvitePreview | null = null;
	let createdUserId: string | null = null;
	let registrationInitialized = false;
	try {
		if (inviteToken) invitation = await consumeRegistrationInvitation(inviteToken);
		const state: RegistrationState = registrationMode === 'approval' && !invitation
			? 'pending_approval'
			: 'awaiting_confirmation';
		const { account, user } = await registerUser(
			env.INSTANCE_DOMAIN,
			email,
			body.password,
			username,
			registrationMode,
			state,
		);
		createdUserId = user.id;

		const { avatarUrl, headerUrl } = await createDefaultImages(
			env.MEDIA_BUCKET,
			env.INSTANCE_DOMAIN,
			account.id,
			username,
		);
		const locale = sanitizeLocale(body.locale);
		await env.DB.batch([
			env.DB.prepare(
				`UPDATE accounts
				 SET avatar_url = ?1, avatar_static_url = ?1,
				     header_url = ?2, header_static_url = ?2
				 WHERE id = ?3`,
			).bind(avatarUrl, headerUrl, account.id),
			env.DB.prepare(
				'UPDATE users SET locale = ?1, reason = ?2 WHERE id = ?3',
			).bind(locale, reason, user.id),
		]);
		await initializeRegistration(user.id, account.id, {
			state,
			invitation,
			redirectUri: body.redirect_uri,
			design: body.design ?? 'default',
		});
		registrationInitialized = true;
		const previousRegistrationToken = getRegistrationSessionFromCookie(c.req.header('Cookie'));
		if (previousRegistrationToken) await revokeRegistrationSession(previousRegistrationToken);
		setRegistrationSessionCookie(c, await createRegistrationSession(user.id));
		clearAuthTokenCookie(c);

		if (state === 'pending_approval') {
			await notifyAdminsPendingUser(username, email, reason).catch(() => undefined);
		}
		return c.json({
			registration_required: true as const,
			registration_state: state,
		});
	} catch (error) {
		if (createdUserId) {
			await deletePendingRegistration(createdUserId).catch(() => undefined);
		}
		if (invitation && !registrationInitialized) {
			await restoreRegistrationInvitation(
				invitation.id,
				invitation.claim_id ?? null,
			).catch(() => undefined);
		}
		throw error;
	}
});

export default app;
