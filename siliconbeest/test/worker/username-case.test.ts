import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser } from './helpers';
import { hashPassword } from '../../server/worker/utils/crypto';

const BASE = 'https://test.siliconbeest.local';

/**
 * Regression tests for username case-sensitivity handling.
 *
 * Historically:
 *   - registration blocked case-variants (COLLATE NOCASE) but stored the
 *     username case-preserved,
 *   - login lowercased the typed identifier and then compared it
 *     case-sensitively against the stored username — so any user whose
 *     username contained an uppercase letter could never log in by username,
 *   - the DB `UNIQUE(username, domain)` used BINARY collation, so case-variant
 *     local accounts ("Alice" / "alice") could coexist via a signup race.
 *
 * These tests pin the fixed behaviour: case-insensitive login, and
 * case-insensitive uniqueness for local accounts (app-level + DB-level).
 */
describe('Username case-sensitivity', () => {
	beforeAll(async () => {
		await applyMigration();
	});

	describe('login is case-insensitive for mixed-case usernames', () => {
		beforeAll(async () => {
			const u = await createTestUser('MixedCaseUser', { email: 'mixedcase@test.local' });
			const hashed = await hashPassword('CorrectHorse123');
			await env.DB_META_C000.prepare('UPDATE users SET encrypted_password = ?1 WHERE id = ?2')
				.bind(hashed, u.userId)
				.run();
		});

		const attempt = (username: string, password = 'CorrectHorse123') =>
			SELF.fetch(`${BASE}/api/v1/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ username, password }),
			});

		it('accepts the exact stored casing', async () => {
			const res = await attempt('MixedCaseUser');
			expect(res.status).toBe(200);
			const body = await res.json<Record<string, unknown>>();
			expect(body.access_token).toBeDefined();
		});

		it('accepts an all-lowercase variant', async () => {
			const res = await attempt('mixedcaseuser');
			expect(res.status).toBe(200);
			const body = await res.json<Record<string, unknown>>();
			expect(body.access_token).toBeDefined();
		});

		it('accepts an all-uppercase variant', async () => {
			const res = await attempt('MIXEDCASEUSER');
			expect(res.status).toBe(200);
			const body = await res.json<Record<string, unknown>>();
			expect(body.access_token).toBeDefined();
		});

		it('still rejects a wrong password regardless of casing', async () => {
			const res = await attempt('mixedcaseuser', 'WrongPassword999');
			expect(res.status).toBe(401);
		});
	});

	describe('case-insensitive uniqueness for local accounts', () => {
		it('rejects registering a case-variant of an existing username', async () => {
			const first = await SELF.fetch(`${BASE}/api/v1/accounts`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					username: 'CaseTaken',
					email: 'casetaken@test.local',
					password: 'securepassword123',
					agreement: true,
				}),
			});
			expect(first.status).toBe(200);

			const variant = await SELF.fetch(`${BASE}/api/v1/accounts`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					username: 'casetaken',
					email: 'casetaken2@test.local',
					password: 'securepassword123',
					agreement: true,
				}),
			});
			expect(variant.status).toBe(422);
		});

		it('the DB rejects a case-variant local account insert (index backstop)', async () => {
			const base = await createTestUser('UniqueGuard', { email: 'uniqueguard@test.local' });
			expect(base.accountId).toBeDefined();

			const now = new Date().toISOString();
			await expect(
				env.DB_META_C000.prepare(
					"INSERT INTO accounts (id, username, domain, uri, url, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?)",
				)
					.bind(
						crypto.randomUUID(),
						'uniqueguard',
						'https://test.siliconbeest.local/users/uniqueguard',
						'https://test.siliconbeest.local/@uniqueguard',
						now,
						now,
					)
					.run(),
			).rejects.toThrow();
		});
	});
});
