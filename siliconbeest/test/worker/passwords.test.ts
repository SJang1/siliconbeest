import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';
import { hashPassword } from '../../server/worker/utils/crypto';

const BASE = 'https://test.siliconbeest.local';

describe('Password endpoints', () => {
	let user: { accountId: string; userId: string; token: string };

	beforeAll(async () => {
		await applyMigration();
		user = await createTestUser('pwuser', { email: 'pwuser@test.local' });

		// Set a real bcrypt hash so verifyPassword works for change_password tests
		const hashed = await hashPassword('OldPassword123');
		await env.DB.prepare('UPDATE users SET encrypted_password = ?1 WHERE id = ?2')
			.bind(hashed, user.userId)
			.run();
	});

	// -----------------------------------------------------------------
	// POST /api/v1/auth/passwords — request password reset
	// -----------------------------------------------------------------
	describe('POST /api/v1/auth/passwords', () => {
		it('returns 200 for a valid username+email (does not reveal whether account exists)', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/auth/passwords`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ username: 'pwuser', email: 'pwuser@test.local' }),
			});
			expect(res.status).toBe(200);
		});

		it('returns 200 even for a non-existent username+email', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/auth/passwords`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ username: 'nobody', email: 'nobody@test.local' }),
			});
			expect(res.status).toBe(200);
		});

		it('returns 422 when username or email is missing', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/auth/passwords`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});
			expect(res.status).toBe(422);
		});
	});

	// -----------------------------------------------------------------
	// POST /api/v1/auth/passwords/reset — reset password with token
	// -----------------------------------------------------------------
	describe('POST /api/v1/auth/passwords/reset', () => {
		it('returns 200 with a valid token and new password', async () => {
			// Set a reset token directly in DB
			const token = 'valid-reset-token-abc123';
			const now = new Date().toISOString();
			await env.DB.prepare(
				'UPDATE users SET reset_password_token = ?1, reset_password_sent_at = ?2 WHERE id = ?3',
			)
				.bind(token, now, user.userId)
				.run();

			const res = await SELF.fetch(`${BASE}/api/v1/auth/passwords/reset`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token, password: 'NewSecurePassword456' }),
			});
			expect(res.status).toBe(200);

			// Verify the token has been cleared
			const dbUser = await env.DB.prepare(
				'SELECT reset_password_token FROM users WHERE id = ?1',
			)
				.bind(user.userId)
				.first();
			expect(dbUser?.reset_password_token).toBeNull();
		});

		it('returns 422 with an expired token', async () => {
			// Set a token with a sent_at 2 hours ago
			const token = 'expired-reset-token-xyz';
			const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
			await env.DB.prepare(
				'UPDATE users SET reset_password_token = ?1, reset_password_sent_at = ?2 WHERE id = ?3',
			)
				.bind(token, twoHoursAgo, user.userId)
				.run();

			const res = await SELF.fetch(`${BASE}/api/v1/auth/passwords/reset`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token, password: 'AnotherPassword789' }),
			});
			expect(res.status).toBe(422);
		});

		it('returns 422 with an invalid token', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/auth/passwords/reset`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token: 'nonexistent-token', password: 'SomePassword123' }),
			});
			expect(res.status).toBe(422);
		});
	});

	// -----------------------------------------------------------------
	// POST /api/v1/accounts/change_password
	// -----------------------------------------------------------------
	describe('POST /api/v1/accounts/change_password', () => {
		beforeAll(async () => {
			// Re-set the password to a known value for change_password tests
			const hashed = await hashPassword('CurrentPass123');
			await env.DB.prepare('UPDATE users SET encrypted_password = ?1 WHERE id = ?2')
				.bind(hashed, user.userId)
				.run();
		});

		it('returns 200 with correct current password', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/accounts/change_password`, {
				method: 'POST',
				headers: authHeaders(user.token),
				body: JSON.stringify({
					current_password: 'CurrentPass123',
					new_password: 'BrandNewPass456',
				}),
			});
			expect(res.status).toBe(200);
		});

		it('returns 422 with wrong current password', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/accounts/change_password`, {
				method: 'POST',
				headers: authHeaders(user.token),
				body: JSON.stringify({
					current_password: 'WrongPassword999',
					new_password: 'AnotherNew789',
				}),
			});
			expect(res.status).toBe(422);
		});

		it('returns 401 without auth', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/accounts/change_password`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					current_password: 'Something',
					new_password: 'AnotherThing',
				}),
			});
			expect(res.status).toBe(401);
		});

		it('returns 422 when new password is too short', async () => {
			// Re-set password first
			const hashed = await hashPassword('KnownPass123');
			await env.DB.prepare('UPDATE users SET encrypted_password = ?1 WHERE id = ?2')
				.bind(hashed, user.userId)
				.run();

			const res = await SELF.fetch(`${BASE}/api/v1/accounts/change_password`, {
				method: 'POST',
				headers: authHeaders(user.token),
				body: JSON.stringify({
					current_password: 'KnownPass123',
					new_password: 'short',
				}),
			});
			expect(res.status).toBe(422);
		});
	});
});
