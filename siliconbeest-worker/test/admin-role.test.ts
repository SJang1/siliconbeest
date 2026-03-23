import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Admin role change', () => {
	let admin: { accountId: string; userId: string; token: string };
	let regularUser: { accountId: string; userId: string; token: string };
	let targetUser: { accountId: string; userId: string; token: string };

	beforeAll(async () => {
		await applyMigration();
		admin = await createTestUser('roleadmin', { role: 'admin' });
		regularUser = await createTestUser('rolenormal');
		targetUser = await createTestUser('roletarget');
	});

	// -----------------------------------------------------------------
	// POST /api/v1/admin/accounts/:id/role
	// -----------------------------------------------------------------
	describe('POST /api/v1/admin/accounts/:id/role', () => {
		it('changes role to moderator as admin — 200', async () => {
			const res = await SELF.fetch(
				`${BASE}/api/v1/admin/accounts/${targetUser.accountId}/role`,
				{
					method: 'POST',
					headers: authHeaders(admin.token),
					body: JSON.stringify({ role: 'moderator' }),
				},
			);
			expect(res.status).toBe(200);
			const body = await res.json<any>();
			expect(body.role).toBe('moderator');
		});

		it('changes role back to user as admin — 200', async () => {
			const res = await SELF.fetch(
				`${BASE}/api/v1/admin/accounts/${targetUser.accountId}/role`,
				{
					method: 'POST',
					headers: authHeaders(admin.token),
					body: JSON.stringify({ role: 'user' }),
				},
			);
			expect(res.status).toBe(200);
			const body = await res.json<any>();
			expect(body.role).toBe('user');
		});

		it('returns 403 for non-admin user', async () => {
			const res = await SELF.fetch(
				`${BASE}/api/v1/admin/accounts/${targetUser.accountId}/role`,
				{
					method: 'POST',
					headers: authHeaders(regularUser.token),
					body: JSON.stringify({ role: 'admin' }),
				},
			);
			expect(res.status).toBe(403);
		});

		it('returns 401 without auth', async () => {
			const res = await SELF.fetch(
				`${BASE}/api/v1/admin/accounts/${targetUser.accountId}/role`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ role: 'admin' }),
				},
			);
			expect(res.status).toBe(401);
		});

		it('returns 422 for invalid role', async () => {
			const res = await SELF.fetch(
				`${BASE}/api/v1/admin/accounts/${targetUser.accountId}/role`,
				{
					method: 'POST',
					headers: authHeaders(admin.token),
					body: JSON.stringify({ role: 'superadmin' }),
				},
			);
			expect(res.status).toBe(422);
		});

		it('returns 404 for non-existent account', async () => {
			const res = await SELF.fetch(
				`${BASE}/api/v1/admin/accounts/nonexistent-id-12345/role`,
				{
					method: 'POST',
					headers: authHeaders(admin.token),
					body: JSON.stringify({ role: 'admin' }),
				},
			);
			expect(res.status).toBe(404);
		});
	});
});
