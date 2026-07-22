import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '../../server/worker/utils/crypto';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

type RegistrationState =
	| 'pending_approval'
	| 'awaiting_confirmation'
	| 'email_verification'
	| 'active';

interface RegistrationRequiredResponse {
	registration_required: true;
	registration_state: RegistrationState;
}

interface EmailVerificationResponse {
	state: 'email_verification';
	email_verification_expires_at: string;
}

interface ActivationResponse {
	state: 'active';
	access_token: string;
	redirect_uri: string;
	passkey_prompt: true;
}

interface PendingUserRow {
	id: string;
	approved: number;
	confirmed_at: string | null;
	confirmation_token: string | null;
	registration_state: RegistrationState;
	email_verification_code_hash: string | null;
	email_verification_expires_at: string | null;
	email_verification_attempts: number;
}

const TABLE_DELETE_ORDER = [
	'webauthn_credentials', 'status_preview_cards', 'preview_cards', 'media_proxy_cache',
	'emoji_reactions', 'filter_statuses', 'filter_keywords', 'filters', 'user_preferences',
	'markers', 'home_timeline_entries', 'conversation_accounts', 'conversations',
	'web_push_subscriptions', 'account_warnings', 'reports', 'list_accounts', 'lists',
	'tag_follows', 'status_tags', 'tags', 'mentions', 'notifications', 'bookmarks',
	'mutes', 'blocks', 'favourites', 'follow_requests', 'follows', 'poll_votes', 'polls',
	'media_attachments', 'statuses', 'oauth_authorization_codes', 'oauth_access_tokens',
	'oauth_applications', 'registration_email_delivery_limits', 'registration_invites',
	'registration_cancellation_cooldowns',
	'actor_keys', 'users', 'accounts',
	'domain_allows', 'domain_blocks', 'email_domain_blocks', 'ip_blocks',
	'instances', 'custom_emojis', 'announcements', 'rules', 'relays', 'settings',
] as const;

let migrated = false;
let registrationIpSuffix = 1;

async function resetDB(): Promise<void> {
	for (const table of TABLE_DELETE_ORDER) {
		try {
			await env.DB_META_C000.prepare(`DELETE FROM "${table}"`).run();
		} catch {
			// A table may not exist when an older migration set is under test.
		}
	}
	await env.DB_META_C000.batch([
		env.DB_META_C000.prepare(
			"INSERT INTO settings (key, value, updated_at) VALUES ('registration_mode', 'open', datetime('now'))",
		),
		env.DB_META_C000.prepare(
			"INSERT INTO settings (key, value, updated_at) VALUES ('require_email_verification', '1', datetime('now'))",
		),
		env.DB_META_C000.prepare(
			"INSERT INTO settings (key, value, updated_at) VALUES ('site_title', 'SiliconBeest', datetime('now'))",
		),
	]);
}

async function setRegistrationSettings(
	mode: 'open' | 'approval',
	requireEmailVerification = true,
): Promise<void> {
	await env.DB_META_C000.batch([
		env.DB_META_C000.prepare(
			"INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('registration_mode', ?1, datetime('now'))",
		).bind(mode),
		env.DB_META_C000.prepare(
			"INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('require_email_verification', ?1, datetime('now'))",
		).bind(requireEmailVerification ? '1' : '0'),
	]);
}

async function registerUser(username: string, reason?: string): Promise<Response> {
	return SELF.fetch(`${BASE}/api/v1/accounts`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'CF-Connecting-IP': `192.0.2.${registrationIpSuffix++}`,
		},
		body: JSON.stringify({
			username,
			email: `${username}@test.local`,
			password: 'securepassword123',
			agreement: true,
			locale: 'en',
			...(reason ? { reason } : {}),
		}),
	});
}

function registrationCookie(response: Response): string {
	const setCookie = response.headers.get('set-cookie');
	expect(setCookie).toContain('siliconbeest_registration=');
	expect(setCookie).toContain('HttpOnly');
	expect(setCookie).toContain('SameSite=Lax');
	const cookie = setCookie?.match(/(?:^|, )(siliconbeest_registration=[^;]+)/)?.[1];
	expect(cookie).toBeTruthy();
	return cookie ?? '';
}

async function registrationRequest(
	path: '/continue' | '/verify' | '/resend',
	cookie: string,
	body?: { code: string },
): Promise<Response> {
	return SELF.fetch(`${BASE}/api/v1/registration${path}`, {
		method: 'POST',
		headers: {
			Cookie: cookie,
			...(body ? { 'Content-Type': 'application/json' } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
}

async function pendingUser(email: string): Promise<PendingUserRow> {
	const user = await env.DB_META_C000.prepare(
		`SELECT id, approved, confirmed_at, confirmation_token, registration_state,
		        email_verification_code_hash, email_verification_expires_at,
		        email_verification_attempts
		 FROM users WHERE email = ?1`,
	).bind(email).first<PendingUserRow>();
	expect(user).toBeTruthy();
	if (!user) throw new Error(`Expected pending user ${email}`);
	return user;
}

describe('registration email verification', () => {
	beforeEach(async () => {
		if (!migrated) {
			await applyMigration();
			migrated = true;
		}
		await resetDB();
	});

	it('defers email verification and keeps an open registration private', async () => {
		const response = await registerUser('verify_deferred');
		expect(response.status).toBe(200);
		expect(await response.json<RegistrationRequiredResponse>()).toEqual({
			registration_required: true,
			registration_state: 'awaiting_confirmation',
		});
		registrationCookie(response);

		expect(await pendingUser('verify_deferred@test.local')).toMatchObject({
			approved: 0,
			confirmed_at: null,
			confirmation_token: null,
			registration_state: 'awaiting_confirmation',
			email_verification_code_hash: null,
			email_verification_expires_at: null,
		});
	});

	it('logs a pending user back into the restricted registration session', async () => {
		await registerUser('verify_login');

		const response = await SELF.fetch(`${BASE}/api/v1/auth/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				username: 'verify_login',
				password: 'securepassword123',
			}),
		});

		expect(response.status).toBe(200);
		const body = await response.json<RegistrationRequiredResponse>();
		expect(body).toEqual({
			registration_required: true,
			registration_state: 'awaiting_confirmation',
		});
		expect('access_token' in body).toBe(false);
		registrationCookie(response);
	});

	it('starts a 60-minute challenge only after the user continues', async () => {
		const registration = await registerUser('verify_challenge');
		const cookie = registrationCookie(registration);
		const queueSend = vi.spyOn(env.QUEUE_EMAIL, 'send');

		const response = await registrationRequest('/continue', cookie);
		expect(response.status).toBe(200);
		const challenge = await response.json<EmailVerificationResponse>();
		expect(challenge.state).toBe('email_verification');
		const remaining = new Date(challenge.email_verification_expires_at).getTime() - Date.now();
		expect(remaining).toBeGreaterThan(55 * 60 * 1000);
		expect(remaining).toBeLessThanOrEqual(60 * 60 * 1000);

		expect(await pendingUser('verify_challenge@test.local')).toMatchObject({
			approved: 0,
			confirmed_at: null,
			registration_state: 'email_verification',
		});
		const user = await pendingUser('verify_challenge@test.local');
		expect(user.confirmation_token).toMatch(/^[0-9a-f]{64}$/);
		expect(user.email_verification_code_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(user.email_verification_expires_at).toBe(challenge.email_verification_expires_at);
		expect(queueSend).toHaveBeenCalledOnce();
		expect(queueSend).toHaveBeenCalledWith(expect.objectContaining({
			type: 'send_email',
			to: 'verify_challenge@test.local',
		}));
		queueSend.mockRestore();
	});

	it('rolls back the challenge when the confirmation email cannot be queued', async () => {
		const registration = await registerUser('verify_queue_failure');
		const cookie = registrationCookie(registration);
		const queueSend = vi.spyOn(env.QUEUE_EMAIL, 'send')
			.mockRejectedValueOnce(new Error('queue unavailable'));

		const failed = await registrationRequest('/continue', cookie);
		expect(failed.status).toBe(503);
		expect(await failed.json<{ error: string }>()).toEqual({
			error: 'Unable to queue confirmation email',
			error_description: 'Please try again.',
		});
		expect(await pendingUser('verify_queue_failure@test.local')).toMatchObject({
			registration_state: 'awaiting_confirmation',
			confirmation_token: null,
			email_verification_code_hash: null,
			email_verification_expires_at: null,
		});

		const retried = await registrationRequest('/continue', cookie);
		expect(retried.status).toBe(200);
		expect(queueSend).toHaveBeenCalledTimes(2);
		queueSend.mockRestore();
	});

	it('rejects an invalid six-digit code without activating the registration', async () => {
		const registration = await registerUser('verify_invalid');
		const cookie = registrationCookie(registration);
		await registrationRequest('/continue', cookie);
		const user = await pendingUser('verify_invalid@test.local');
		const invalidCode = user.email_verification_code_hash === await sha256('000000')
			? '000001'
			: '000000';

		const response = await registrationRequest('/verify', cookie, { code: invalidCode });
		expect(response.status).toBe(422);
		expect(await pendingUser('verify_invalid@test.local')).toMatchObject({
			approved: 0,
			confirmed_at: null,
			registration_state: 'email_verification',
			email_verification_attempts: 1,
		});
	});

	it('atomically limits parallel verification guesses to eight attempts', async () => {
		const registration = await registerUser('verify_parallel_limit');
		const cookie = registrationCookie(registration);
		await registrationRequest('/continue', cookie);
		const user = await pendingUser('verify_parallel_limit@test.local');
		const invalidCode = user.email_verification_code_hash === await sha256('000000')
			? '000001'
			: '000000';

		const responses = await Promise.all(Array.from({ length: 24 }, (_, index) =>
			SELF.fetch(`${BASE}/api/v1/registration/verify`, {
				method: 'POST',
				headers: {
					Cookie: cookie,
					'Content-Type': 'application/json',
					'CF-Connecting-IP': `203.0.113.${index + 1}`,
				},
				body: JSON.stringify({ code: invalidCode }),
			}),
		));
		const statuses = responses.map((response) => response.status);
		expect(statuses.filter((status) => status === 422)).toHaveLength(8);
		expect(statuses.filter((status) => status === 429)).toHaveLength(16);
		expect(await pendingUser('verify_parallel_limit@test.local')).toMatchObject({
			approved: 0,
			confirmed_at: null,
			registration_state: 'email_verification',
			email_verification_attempts: 8,
		});
	});

	it('activates a registration after a valid six-digit code', async () => {
		const registration = await registerUser('verify_code');
		const cookie = registrationCookie(registration);
		await registrationRequest('/continue', cookie);

		const code = '314159';
		const user = await pendingUser('verify_code@test.local');
		await env.DB_META_C000.prepare(
			'UPDATE users SET email_verification_code_hash = ?1 WHERE id = ?2',
		).bind(await sha256(code), user.id).run();

		const response = await registrationRequest('/verify', cookie, { code });
		expect(response.status).toBe(200);
		expect(await response.json<ActivationResponse>()).toMatchObject({
			state: 'active',
			redirect_uri: '/home',
			passkey_prompt: true,
		});
		expect(await pendingUser('verify_code@test.local')).toMatchObject({
			approved: 1,
			registration_state: 'active',
			email_verification_code_hash: null,
			email_verification_expires_at: null,
			email_verification_attempts: 0,
		});
		expect((await pendingUser('verify_code@test.local')).confirmed_at).toBeTruthy();
	});

	it('issues credentials only once for parallel valid code submissions', async () => {
		const registration = await registerUser('verify_parallel_valid');
		const cookie = registrationCookie(registration);
		await registrationRequest('/continue', cookie);
		const code = '271828';
		const user = await pendingUser('verify_parallel_valid@test.local');
		await env.DB_META_C000.prepare(
			'UPDATE users SET email_verification_code_hash = ?1 WHERE id = ?2',
		).bind(await sha256(code), user.id).run();

		const responses = await Promise.all([1, 2].map((suffix) =>
			SELF.fetch(`${BASE}/api/v1/registration/verify`, {
				method: 'POST',
				headers: {
					Cookie: cookie,
					'Content-Type': 'application/json',
					'CF-Connecting-IP': `198.51.100.${suffix}`,
				},
				body: JSON.stringify({ code }),
			}),
		));
		expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
		expect(responses.filter((response) => [401, 409, 410].includes(response.status))).toHaveLength(1);
		expect(await env.DB_META_C000.prepare(
			'SELECT COUNT(*) AS count FROM oauth_access_tokens WHERE user_id = ?1',
		).bind(user.id).first<{ count: number }>()).toEqual({ count: 1 });
	});

	it('rate-limits resends and replaces a challenge without resetting failed attempts', async () => {
		const registration = await registerUser('verify_resend');
		const cookie = registrationCookie(registration);
		await registrationRequest('/continue', cookie);
		let before = await pendingUser('verify_resend@test.local');
		const invalidCode = before.email_verification_code_hash === await sha256('000000')
			? '000001'
			: '000000';
		expect((await registrationRequest('/verify', cookie, { code: invalidCode })).status).toBe(422);
		before = await pendingUser('verify_resend@test.local');

		const tooSoon = await registrationRequest('/resend', cookie);
		expect(tooSoon.status).toBe(429);
		expect(await pendingUser('verify_resend@test.local')).toMatchObject({
			confirmation_token: before.confirmation_token,
			email_verification_code_hash: before.email_verification_code_hash,
			email_verification_attempts: 1,
		});

		await env.DB_META_C000.prepare(
			"UPDATE registration_email_delivery_limits SET last_sent_at = datetime('now', '-2 minutes') WHERE email_hash = ?1",
		).bind(await sha256('verify_resend@test.local')).run();
		const response = await registrationRequest('/resend', cookie);
		expect(response.status).toBe(200);
		expect(await response.json<EmailVerificationResponse>()).toMatchObject({
			state: 'email_verification',
		});
		const after = await pendingUser('verify_resend@test.local');
		expect(after.confirmation_token).not.toBe(before.confirmation_token);
		expect(after.email_verification_code_hash).not.toBe(before.email_verification_code_hash);
		expect(after.email_verification_attempts).toBe(1);
	});

	it('atomically enforces the persistent daily email delivery limit', async () => {
		const registration = await registerUser('verify_daily_limit');
		const cookie = registrationCookie(registration);
		await registrationRequest('/continue', cookie);
		await env.DB_META_C000.prepare(
			`UPDATE registration_email_delivery_limits
			 SET send_count = 9, last_sent_at = datetime('now', '-2 minutes')
			 WHERE email_hash = ?1`,
		).bind(await sha256('verify_daily_limit@test.local')).run();

		const responses = await Promise.all([1, 2].map((suffix) =>
			SELF.fetch(`${BASE}/api/v1/registration/resend`, {
				method: 'POST',
				headers: {
					Cookie: cookie,
					'CF-Connecting-IP': `203.0.113.${suffix}`,
				},
			}),
		));
		expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
		expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
		expect(await env.DB_META_C000.prepare(
			'SELECT send_count FROM registration_email_delivery_limits WHERE email_hash = ?1',
		).bind(await sha256('verify_daily_limit@test.local')).first<{ send_count: number }>())
			.toEqual({ send_count: 10 });

		await env.DB_META_C000.prepare(
			"UPDATE registration_email_delivery_limits SET last_sent_at = datetime('now', '-2 minutes') WHERE email_hash = ?1",
		).bind(await sha256('verify_daily_limit@test.local')).run();
		expect((await registrationRequest('/resend', cookie)).status).toBe(429);
	});

	it('keeps email delivery limits after a pending registration is cancelled', async () => {
		const firstRegistration = await registerUser('verify_cancel_limit');
		const firstCookie = registrationCookie(firstRegistration);
		expect((await registrationRequest('/continue', firstCookie)).status).toBe(200);
		expect((await SELF.fetch(`${BASE}/api/v1/registration/cancel`, {
			method: 'POST',
			headers: { Cookie: firstCookie },
		})).status).toBe(200);

		expect((await registerUser('verify_cancel_limit')).status).toBe(429);
		await env.DB_META_C000.prepare(
			"UPDATE registration_cancellation_cooldowns SET expires_at = datetime('now', '-1 second') WHERE email_hash = ?1",
		).bind(await sha256('verify_cancel_limit@test.local')).run();
		const secondRegistration = await registerUser('verify_cancel_limit');
		const secondCookie = registrationCookie(secondRegistration);
		expect((await registrationRequest('/continue', secondCookie)).status).toBe(429);
		expect(await env.DB_META_C000.prepare(
			'SELECT send_count FROM registration_email_delivery_limits WHERE email_hash = ?1',
		).bind(await sha256('verify_cancel_limit@test.local')).first<{ send_count: number }>())
			.toEqual({ send_count: 1 });
	});

	it('resends directly after an open challenge expires', async () => {
		const registration = await registerUser('verify_expired_resend');
		const cookie = registrationCookie(registration);
		await registrationRequest('/continue', cookie);
		const before = await pendingUser('verify_expired_resend@test.local');
		await env.DB_META_C000.prepare(
			"UPDATE users SET email_verification_expires_at = datetime('now', '-1 minute') WHERE id = ?1",
		).bind(before.id).run();
		await env.DB_META_C000.prepare(
			"UPDATE registration_email_delivery_limits SET last_sent_at = datetime('now', '-2 minutes') WHERE email_hash = ?1",
		).bind(await sha256('verify_expired_resend@test.local')).run();

		const response = await registrationRequest('/resend', cookie);
		expect(response.status).toBe(200);
		expect(await response.json<EmailVerificationResponse>()).toMatchObject({
			state: 'email_verification',
		});
		const after = await pendingUser('verify_expired_resend@test.local');
		expect(after.registration_state).toBe('email_verification');
		expect(after.confirmation_token).not.toBe(before.confirmation_token);
		expect(new Date(after.email_verification_expires_at ?? '').getTime()).toBeGreaterThan(Date.now());
	});

	it('activates immediately on continue when email verification is disabled', async () => {
		await setRegistrationSettings('open', false);
		const registration = await registerUser('verify_disabled');
		const cookie = registrationCookie(registration);

		const response = await registrationRequest('/continue', cookie);
		expect(response.status).toBe(200);
		expect(await response.json<ActivationResponse>()).toMatchObject({
			state: 'active',
			redirect_uri: '/home',
		});
		expect(await pendingUser('verify_disabled@test.local')).toMatchObject({
			approved: 1,
			registration_state: 'active',
		});
	});

	it('issues credentials only once for parallel continuation without email verification', async () => {
		await setRegistrationSettings('open', false);
		const registration = await registerUser('verify_parallel_continue');
		const cookie = registrationCookie(registration);
		const user = await pendingUser('verify_parallel_continue@test.local');

		const responses = await Promise.all([3, 4].map((suffix) =>
			SELF.fetch(`${BASE}/api/v1/registration/continue`, {
				method: 'POST',
				headers: {
					Cookie: cookie,
					'CF-Connecting-IP': `198.51.100.${suffix}`,
				},
			}),
		));
		expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
		expect(responses.filter((response) => [401, 409, 410].includes(response.status))).toHaveLength(1);
		expect(await env.DB_META_C000.prepare(
			'SELECT COUNT(*) AS count FROM oauth_access_tokens WHERE user_id = ?1',
		).bind(user.id).first<{ count: number }>()).toEqual({ count: 1 });
	});

	it('lets an admin approve before email verification and then requires user confirmation', async () => {
		await setRegistrationSettings('approval');
		const registration = await registerUser('verify_approval', 'I would like to join.');
		expect(registration.status).toBe(200);
		expect(await registration.json<RegistrationRequiredResponse>()).toMatchObject({
			registration_state: 'pending_approval',
		});

		const account = await env.DB_META_C000.prepare(
			"SELECT id FROM accounts WHERE username = 'verify_approval' AND domain IS NULL",
		).first<{ id: string }>();
		expect(account).toBeTruthy();
		const admin = await createTestUser('verification_admin', { role: 'admin' });
		const response = await SELF.fetch(
			`${BASE}/api/v1/admin/accounts/${account?.id}/approve`,
			{ method: 'POST', headers: authHeaders(admin.token) },
		);

		expect(response.status).toBe(200);
		expect(await pendingUser('verify_approval@test.local')).toMatchObject({
			approved: 0,
			confirmed_at: null,
			registration_state: 'awaiting_confirmation',
			confirmation_token: null,
		});
	});
});
