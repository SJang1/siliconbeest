import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';

const BASE = 'https://test.siliconbeest.local';

describe('Admin role change', () => {
	let admin: { accountId: string; userId: string; token: string };
	let regularUser: { accountId: string; userId: string; token: string };
	let moderator: { accountId: string; userId: string; token: string };
	let otherModerator: { accountId: string; userId: string; token: string };
	let targetUser: { accountId: string; userId: string; token: string };

	beforeAll(async () => {
		await applyMigration();
		admin = await createTestUser('roleadmin', { role: 'admin' });
		regularUser = await createTestUser('rolenormal');
		moderator = await createTestUser('rolemoderator', { role: 'moderator' });
		otherModerator = await createTestUser('rolemoderator2', { role: 'moderator' });
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

		it('returns 403 for a moderator and leaves the target role unchanged', async () => {
			const res = await SELF.fetch(
				`${BASE}/api/v1/admin/accounts/${targetUser.accountId}/role`,
				{
					method: 'POST',
					headers: authHeaders(moderator.token),
					body: JSON.stringify({ role: 'admin' }),
				},
			);
			expect(res.status).toBe(403);
			const target = await env.DB_META_C000.prepare(
				'SELECT role FROM users WHERE account_id = ?1',
			).bind(targetUser.accountId).first<{ role: string }>();
			expect(target?.role).toBe('user');
		});

		it('prevents a moderator from taking action against an admin or themselves', async () => {
			for (const accountId of [admin.accountId, moderator.accountId]) {
				const res = await SELF.fetch(
					`${BASE}/api/v1/admin/accounts/${accountId}/action`,
					{
						method: 'POST',
						headers: authHeaders(moderator.token),
						body: JSON.stringify({ type: 'suspend', send_email_notification: false }),
					},
				);
				expect(res.status).toBe(403);
			}
		});

		it('prevents moderator undo actions against self, admins, and other moderators', async () => {
			const restrictedAccountIds = [
				moderator.accountId,
				admin.accountId,
				otherModerator.accountId,
			];
			for (const accountId of restrictedAccountIds) {
				for (const action of ['unsuspend', 'unsilence', 'enable', 'unsensitize']) {
					const res = await SELF.fetch(
						`${BASE}/api/v1/admin/accounts/${accountId}/${action}`,
						{ method: 'POST', headers: authHeaders(moderator.token) },
					);
					expect(res.status).toBe(403);
				}
			}
		});

		it('allows a moderator to undo an action on a normal user', async () => {
			await env.DB_META_C000.prepare("UPDATE users SET email = '', disabled = 1 WHERE account_id = ?1")
				.bind(targetUser.accountId)
				.run();
			const res = await SELF.fetch(
				`${BASE}/api/v1/admin/accounts/${targetUser.accountId}/enable`,
				{ method: 'POST', headers: authHeaders(moderator.token) },
			);
			expect(res.status).toBe(200);
			const target = await env.DB_META_C000.prepare(
				'SELECT disabled FROM users WHERE account_id = ?1',
			).bind(targetUser.accountId).first<{ disabled: number }>();
			expect(target?.disabled).toBe(0);
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

		it('invalidates cached token roles immediately after a demotion', async () => {
			const cachedAdmin = await createTestUser('rolecachedadmin');
			const promote = await SELF.fetch(
				`${BASE}/api/v1/admin/accounts/${cachedAdmin.accountId}/role`,
				{
					method: 'POST',
					headers: authHeaders(admin.token),
					body: JSON.stringify({ role: 'admin' }),
				},
			);
			expect(promote.status).toBe(200);

			// Populate the token KV payload while the promoted role is active.
			const prime = await SELF.fetch(`${BASE}/api/v1/accounts/verify_credentials`, {
				headers: authHeaders(cachedAdmin.token),
			});
			expect(prime.status).toBe(200);

			const demote = await SELF.fetch(
				`${BASE}/api/v1/admin/accounts/${cachedAdmin.accountId}/role`,
				{
					method: 'POST',
					headers: authHeaders(admin.token),
					body: JSON.stringify({ role: 'user' }),
				},
			);
			expect(demote.status).toBe(200);

			const stalePrivilegeAttempt = await SELF.fetch(
				`${BASE}/api/v1/admin/accounts/${regularUser.accountId}/role`,
				{
					method: 'POST',
					headers: authHeaders(cachedAdmin.token),
					body: JSON.stringify({ role: 'moderator' }),
				},
			);
			expect(stalePrivilegeAttempt.status).toBe(403);
		});
	});
});
