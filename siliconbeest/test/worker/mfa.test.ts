import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';
import { base32Decode } from '../../server/worker/utils/totp';

const BASE = 'https://test.siliconbeest.local';

/**
 * Generate a valid TOTP code for a given base32 secret.
 * Mirrors the server-side TOTP implementation for test verification.
 */
async function generateTOTPCode(secret: string): Promise<string> {
	const secretBytes = base32Decode(secret);
	const now = Math.floor(Date.now() / 1000);
	const counter = BigInt(Math.floor(now / 30));

	const counterBytes = new Uint8Array(8);
	let c = counter;
	for (let i = 7; i >= 0; i--) {
		counterBytes[i] = Number(c & 0xffn);
		c >>= 8n;
	}

	const key = await crypto.subtle.importKey(
		'raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
	);
	const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes));

	const offset = hmac[hmac.length - 1] & 0x0f;
	const binary =
		((hmac[offset] & 0x7f) << 24) |
		((hmac[offset + 1] & 0xff) << 16) |
		((hmac[offset + 2] & 0xff) << 8) |
		(hmac[offset + 3] & 0xff);

	const otp = binary % 1000000;
	return otp.toString().padStart(6, '0');
}

describe('MFA (TOTP Two-Factor Authentication)', () => {
	beforeAll(async () => {
		await applyMigration();
	});

	// -------------------------------------------------------------------
	// POST /api/v1/auth/mfa/setup
	// -------------------------------------------------------------------
	describe('POST /api/v1/auth/mfa/setup', () => {
		it('returns 401 without authentication', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/auth/mfa/setup`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
			});
			expect(res.status).toBe(401);
		});

		it('generates TOTP secret, URI, and backup codes', async () => {
			const { token } = await createTestUser('mfa_setup_user');

			const res = await SELF.fetch(`${BASE}/api/v1/auth/mfa/setup`, {
				method: 'POST',
				headers: authHeaders(token),
			});

			expect(res.status).toBe(200);
			const body = await res.json<Record<string, any>>();

			// Secret should be a base32 string (uppercase alphanumeric)
			expect(body.secret).toBeDefined();
			expect(body.secret.length).toBeGreaterThan(0);
			expect(body.secret).toMatch(/^[A-Z2-7]+$/);

			// URI should be a valid otpauth:// URI
			expect(body.uri).toBeDefined();
			expect(body.uri).toContain('otpauth://totp/');
			expect(body.uri).toContain(body.secret);

			// Should return 10 backup codes
			expect(body.backup_codes).toBeDefined();
			expect(Array.isArray(body.backup_codes)).toBe(true);
			expect(body.backup_codes.length).toBe(10);

			// Each backup code should be 8 characters
			for (const code of body.backup_codes) {
				expect(code.length).toBe(8);
			}
		});

		it('does not enable 2FA yet (otp_enabled stays 0)', async () => {
			const { token, userId } = await createTestUser('mfa_setup_not_enabled');

			await SELF.fetch(`${BASE}/api/v1/auth/mfa/setup`, {
				method: 'POST',
				headers: authHeaders(token),
			});

			// Verify otp_enabled is still 0 in DB
			const row = await env.DB.prepare(
				'SELECT otp_enabled, otp_secret FROM users WHERE id = ?',
			).bind(userId).first<{ otp_enabled: number; otp_secret: string | null }>();

			expect(row!.otp_enabled).toBe(0);
			expect(row!.otp_secret).not.toBeNull(); // Secret is stored but not enabled
		});
	});

	// -------------------------------------------------------------------
	// POST /api/v1/auth/mfa/confirm
	// -------------------------------------------------------------------
	describe('POST /api/v1/auth/mfa/confirm', () => {
		it('returns 401 without authentication', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/auth/mfa/confirm`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ code: '123456' }),
			});
			expect(res.status).toBe(401);
		});

		it('returns 422 when code is missing', async () => {
			const { token } = await createTestUser('mfa_confirm_no_code');

			const res = await SELF.fetch(`${BASE}/api/v1/auth/mfa/confirm`, {
				method: 'POST',
				headers: authHeaders(token),
				body: JSON.stringify({}),
			});

			expect(res.status).toBe(422);
		});

		it('returns 422 when setup has not been called', async () => {
			const { token } = await createTestUser('mfa_confirm_no_setup');

			const res = await SELF.fetch(`${BASE}/api/v1/auth/mfa/confirm`, {
				method: 'POST',
				headers: authHeaders(token),
				body: JSON.stringify({ code: '123456' }),
			});

			expect(res.status).toBe(422);
		});

		it('returns 401 for an invalid TOTP code', async () => {
			const { token } = await createTestUser('mfa_confirm_bad_code');

			// Setup first
			await SELF.fetch(`${BASE}/api/v1/auth/mfa/setup`, {
				method: 'POST',
				headers: authHeaders(token),
			});

			// Confirm with wrong code
			const res = await SELF.fetch(`${BASE}/api/v1/auth/mfa/confirm`, {
				method: 'POST',
				headers: authHeaders(token),
				body: JSON.stringify({ code: '000000' }),
			});

			expect(res.status).toBe(401);
		});

		it('enables 2FA with a valid TOTP code', async () => {
			const { token, userId } = await createTestUser('mfa_confirm_ok');

			// Setup — get the secret
			const setupRes = await SELF.fetch(`${BASE}/api/v1/auth/mfa/setup`, {
				method: 'POST',
				headers: authHeaders(token),
			});
			const { secret } = await setupRes.json<{ secret: string }>();

			// Generate a valid TOTP code from the secret
			const validCode = await generateTOTPCode(secret);

			// Confirm
			const res = await SELF.fetch(`${BASE}/api/v1/auth/mfa/confirm`, {
				method: 'POST',
				headers: authHeaders(token),
				body: JSON.stringify({ code: validCode }),
			});

			expect(res.status).toBe(200);
			const body = await res.json<Record<string, any>>();
			expect(body.success).toBe(true);

			// Verify otp_enabled is now 1 in DB
			const row = await env.DB.prepare(
				'SELECT otp_enabled FROM users WHERE id = ?',
			).bind(userId).first<{ otp_enabled: number }>();
			expect(row!.otp_enabled).toBe(1);
		});

		it('returns 422 when 2FA is already enabled', async () => {
			const { token } = await createTestUser('mfa_confirm_already');

			// Setup
			const setupRes = await SELF.fetch(`${BASE}/api/v1/auth/mfa/setup`, {
				method: 'POST',
				headers: authHeaders(token),
			});
			expect(setupRes.status).toBe(200);
			const setupBody = await setupRes.json<{ secret: string }>();
			const secret = setupBody.secret;
			expect(secret).toBeDefined();

			// Confirm
			const validCode = await generateTOTPCode(secret);
			await SELF.fetch(`${BASE}/api/v1/auth/mfa/confirm`, {
				method: 'POST',
				headers: authHeaders(token),
				body: JSON.stringify({ code: validCode }),
			});

			// Try to confirm again
			const code2 = await generateTOTPCode(secret);
			const res = await SELF.fetch(`${BASE}/api/v1/auth/mfa/confirm`, {
				method: 'POST',
				headers: authHeaders(token),
				body: JSON.stringify({ code: code2 }),
			});

			expect(res.status).toBe(422);
		});
	});

	// -------------------------------------------------------------------
	// POST /api/v1/auth/mfa/disable
	// -------------------------------------------------------------------
	describe('POST /api/v1/auth/mfa/disable', () => {
		it('returns 401 without authentication', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/auth/mfa/disable`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ password: 'test' }),
			});
			expect(res.status).toBe(401);
		});

		it('returns 422 when password is missing', async () => {
			const { token } = await createTestUser('mfa_disable_no_pw');

			const res = await SELF.fetch(`${BASE}/api/v1/auth/mfa/disable`, {
				method: 'POST',
				headers: authHeaders(token),
				body: JSON.stringify({}),
			});

			expect(res.status).toBe(422);
		});

		it('returns 401 for wrong password', async () => {
			const { token } = await createTestUser('mfa_disable_bad_pw');

			const res = await SELF.fetch(`${BASE}/api/v1/auth/mfa/disable`, {
				method: 'POST',
				headers: authHeaders(token),
				body: JSON.stringify({ password: 'wrongpassword' }),
			});

			expect(res.status).toBe(401);
		});

		it('disables 2FA and clears OTP data with correct password', async () => {
			// Create a user with a real password via registration
			const email = 'mfa_disable_ok@test.local';
			const password = 'securepassword123';

			// Register user
			const regRes = await SELF.fetch(`${BASE}/api/v1/accounts`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					username: 'mfa_disable_ok',
					email,
					password,
					agreement: true,
					locale: 'en',
				}),
			});
			expect(regRes.status).toBe(200);

			// Confirm email and get a token
			const user = await env.DB.prepare(
				'SELECT id FROM users WHERE email = ?',
			).bind(email).first<{ id: string }>();

			await env.DB.prepare(
				"UPDATE users SET confirmed_at = datetime('now') WHERE id = ?",
			).bind(user!.id).run();

			// Login to get token
			const loginRes = await SELF.fetch(`${BASE}/api/v1/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email, password }),
			});
			expect(loginRes.status).toBe(200);
			const { access_token: token } = await loginRes.json<{ access_token: string }>();

			// Setup 2FA
			const setupRes = await SELF.fetch(`${BASE}/api/v1/auth/mfa/setup`, {
				method: 'POST',
				headers: authHeaders(token),
			});
			expect(setupRes.status).toBe(200);
			const setupBody = await setupRes.json<{ secret: string }>();
			expect(setupBody.secret).toBeDefined();

			// Confirm 2FA
			const validCode = await generateTOTPCode(setupBody.secret);
			const confirmRes = await SELF.fetch(`${BASE}/api/v1/auth/mfa/confirm`, {
				method: 'POST',
				headers: authHeaders(token),
				body: JSON.stringify({ code: validCode }),
			});
			expect(confirmRes.status).toBe(200);

			// Verify 2FA is enabled
			const before = await env.DB.prepare(
				'SELECT otp_enabled FROM users WHERE id = ?',
			).bind(user!.id).first<{ otp_enabled: number }>();
			expect(before!.otp_enabled).toBe(1);

			// Disable 2FA
			const res = await SELF.fetch(`${BASE}/api/v1/auth/mfa/disable`, {
				method: 'POST',
				headers: authHeaders(token),
				body: JSON.stringify({ password }),
			});

			expect(res.status).toBe(200);
			const body = await res.json<Record<string, any>>();
			expect(body.success).toBe(true);

			// Verify OTP data is cleared
			const after = await env.DB.prepare(
				'SELECT otp_enabled, otp_secret, otp_backup_codes FROM users WHERE id = ?',
			).bind(user!.id).first<{ otp_enabled: number; otp_secret: string | null; otp_backup_codes: string | null }>();
			expect(after!.otp_enabled).toBe(0);
			expect(after!.otp_secret).toBeNull();
			expect(after!.otp_backup_codes).toBeNull();
		});
	});

	// -------------------------------------------------------------------
	// verify_credentials reflects otp_enabled
	// -------------------------------------------------------------------
	describe('GET /api/v1/accounts/verify_credentials (otp_enabled)', () => {
		it('returns otp_enabled: false for new user', async () => {
			const { token } = await createTestUser('mfa_creds_new');

			const res = await SELF.fetch(`${BASE}/api/v1/accounts/verify_credentials`, {
				headers: authHeaders(token),
			});

			expect(res.status).toBe(200);
			const body = await res.json<Record<string, any>>();
			expect(body.otp_enabled).toBe(false);
		});

		it('returns otp_enabled: true after enabling 2FA', async () => {
			const { token } = await createTestUser('mfa_creds_enabled');

			// Setup + confirm
			const setupRes = await SELF.fetch(`${BASE}/api/v1/auth/mfa/setup`, {
				method: 'POST',
				headers: authHeaders(token),
			});
			expect(setupRes.status).toBe(200);
			const setupBody = await setupRes.json<{ secret: string }>();
			expect(setupBody.secret).toBeDefined();

			const validCode = await generateTOTPCode(setupBody.secret);
			await SELF.fetch(`${BASE}/api/v1/auth/mfa/confirm`, {
				method: 'POST',
				headers: authHeaders(token),
				body: JSON.stringify({ code: validCode }),
			});

			// Check verify_credentials
			const res = await SELF.fetch(`${BASE}/api/v1/accounts/verify_credentials`, {
				headers: authHeaders(token),
			});

			expect(res.status).toBe(200);
			const body = await res.json<Record<string, any>>();
			expect(body.otp_enabled).toBe(true);
		});
	});
});
