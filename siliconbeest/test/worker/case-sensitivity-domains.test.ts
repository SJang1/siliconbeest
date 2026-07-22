import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyMigration, createTestUser, authHeaders } from './helpers';
import { hashPassword } from '../../server/worker/utils/crypto';
import { parseContent } from '../../server/worker/utils/contentParser';
import { isDomainBlocked } from '../../../packages/shared/domain-blocks';
import { isEmailDomainBlocked } from '../../server/worker/services/instance';

const BASE = 'https://test.siliconbeest.local';

/**
 * Regression tests for domain/email/mention case-sensitivity handling.
 *
 * Historically, moderation tables stored admin input verbatim while every
 * enforcement path compared a LOWERCASED domain — so a block saved as
 * 'Spam.Example.Com' silently never matched (fail-open). Mention parsing
 * kept the typed domain casing (missing cached remote accounts), and local
 * mentions resolved with a case-sensitive exact match ('@alice' for stored
 * 'Alice' silently created no mention row).
 *
 * Policy: usernames are case-preserved and AP identity is exact-case;
 * auth flows and uniqueness are case-insensitive; domains and emails are
 * normalized to lowercase.
 */
describe('Domain & mention case-sensitivity', () => {
	let admin: { accountId: string; userId: string; token: string };

	beforeAll(async () => {
		await applyMigration();
		admin = await createTestUser('domaincaseadmin', { role: 'admin', email: 'domaincaseadmin@test.local' });
	});

	describe('admin domain blocks normalize to lowercase', () => {
		it('stores a mixed-case domain lowercased and enforcement matches', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/admin/domain_blocks`, {
				method: 'POST',
				headers: authHeaders(admin.token),
				body: JSON.stringify({ domain: 'Bad.Example.Com', severity: 'suspend' }),
			});
			expect(res.status).toBe(200);
			const body = await res.json<Record<string, unknown>>();
			expect(body.domain).toBe('bad.example.com');

			// Enforcement compares lowercase — must now match (cache bypassed).
			const blocked = await isDomainBlocked(env.DB_META_C000, null, 'bad.example.com');
			expect(blocked.blocked).toBe(true);

			// Inbound mixed-case host normalizes to the same answer.
			const blockedMixed = await isDomainBlocked(env.DB_META_C000, null, 'BAD.EXAMPLE.COM');
			expect(blockedMixed.blocked).toBe(true);
		});

		it('rejects a case-variant duplicate of an existing block', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/admin/domain_blocks`, {
				method: 'POST',
				headers: authHeaders(admin.token),
				body: JSON.stringify({ domain: 'BAD.Example.COM' }),
			});
			expect(res.status).toBe(422);
		});

		it('the DB rejects a case-variant row directly (index backstop)', async () => {
			const now = new Date().toISOString();
			await expect(
				env.DB_META_C000.prepare(
					'INSERT INTO domain_blocks (id, domain, severity, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)',
				).bind(crypto.randomUUID(), 'Bad.EXAMPLE.com', 'suspend', now).run(),
			).rejects.toThrow();
		});
	});

	describe('admin email domain blocks normalize to lowercase', () => {
		it('a mixed-case email domain block actually blocks signups', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/admin/email_domain_blocks`, {
				method: 'POST',
				headers: authHeaders(admin.token),
				body: JSON.stringify({ domain: 'Blocked.Mail.Example' }),
			});
			expect(res.status).toBe(200);
			const body = await res.json<Record<string, unknown>>();
			expect(body.domain).toBe('blocked.mail.example');

			expect(await isEmailDomainBlocked('blocked.mail.example')).toBe(true);

			const signup = await SELF.fetch(`${BASE}/api/v1/accounts`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					username: 'blockeddomainuser',
					email: 'someone@Blocked.Mail.Example',
					password: 'securepassword123',
					agreement: true,
				}),
			});
			expect(signup.status).toBe(422);
		});
	});

	describe('admin domain allows normalize to lowercase', () => {
		it('stores lowercase and rejects case-variant duplicates', async () => {
			const first = await SELF.fetch(`${BASE}/api/v1/admin/domain_allows`, {
				method: 'POST',
				headers: authHeaders(admin.token),
				body: JSON.stringify({ domain: 'Friendly.Example.Org' }),
			});
			expect(first.status).toBe(200);
			const body = await first.json<Record<string, unknown>>();
			expect(body.domain).toBe('friendly.example.org');

			const dup = await SELF.fetch(`${BASE}/api/v1/admin/domain_allows`, {
				method: 'POST',
				headers: authHeaders(admin.token),
				body: JSON.stringify({ domain: 'friendly.EXAMPLE.org' }),
			});
			expect(dup.status).toBe(422);
		});
	});

	describe('mention parsing lowercases remote domains', () => {
		it('canonicalizes the domain and dedupes case-variant remote mentions', () => {
			const parsed = parseContent(
				'@bob@Remote.Example hi again @bob@remote.example',
				'test.siliconbeest.local',
			);
			const bobMentions = parsed.mentions.filter((m) => m.username === 'bob');
			expect(bobMentions).toHaveLength(1);
			expect(bobMentions[0]!.domain).toBe('remote.example');
			expect(bobMentions[0]!.acct).toBe('bob@remote.example');
		});

		it('preserves the username casing (AP identity)', () => {
			const parsed = parseContent('@Bob@Remote.Example hello', 'test.siliconbeest.local');
			expect(parsed.mentions[0]!.username).toBe('Bob');
			expect(parsed.mentions[0]!.acct).toBe('Bob@remote.example');
		});
	});

	describe('local mentions resolve case-insensitively', () => {
		let author: { accountId: string; userId: string; token: string };
		let target: { accountId: string; userId: string; token: string };

		beforeAll(async () => {
			author = await createTestUser('mentionauthor', { email: 'mentionauthor@test.local' });
			target = await createTestUser('MentionTarget', { email: 'mentiontarget@test.local' });
		});

		it("'@mentiontarget' reaches the stored 'MentionTarget' account", async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
				method: 'POST',
				headers: authHeaders(author.token),
				body: JSON.stringify({ status: 'hello @mentiontarget !', visibility: 'public' }),
			});
			expect(res.status).toBe(200);
			const body = await res.json<Record<string, any>>();

			const mention = await env.DB_META_C000.prepare(
				'SELECT account_id FROM mentions WHERE status_id = ?1 AND account_id = ?2',
			).bind(body.id, target.accountId).first();
			expect(mention).not.toBeNull();
		});

		it('case-variants of one account fold to a single mention row', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/statuses`, {
				method: 'POST',
				headers: authHeaders(author.token),
				body: JSON.stringify({ status: '@MentionTarget and @mentiontarget twice', visibility: 'public' }),
			});
			expect(res.status).toBe(200);
			const body = await res.json<Record<string, any>>();

			const rows = await env.DB_META_C000.prepare(
				'SELECT account_id FROM mentions WHERE status_id = ?1',
			).bind(body.id).all();
			const targetRows = (rows.results ?? []).filter((r) => r.account_id === target.accountId);
			expect(targetRows).toHaveLength(1);
		});
	});

	describe('email login is case-insensitive', () => {
		beforeAll(async () => {
			const u = await createTestUser('emailcaseuser', { email: 'emailcase@test.local' });
			const hashed = await hashPassword('CorrectHorse123');
			await env.DB_META_C000.prepare('UPDATE users SET encrypted_password = ?1 WHERE id = ?2')
				.bind(hashed, u.userId)
				.run();
		});

		it('accepts a case-variant of the stored (lowercase) email', async () => {
			const res = await SELF.fetch(`${BASE}/api/v1/auth/login`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ username: 'EMAILCASE@TEST.LOCAL', password: 'CorrectHorse123' }),
			});
			expect(res.status).toBe(200);
			const body = await res.json<Record<string, unknown>>();
			expect(body.access_token).toBeDefined();
		});
	});
});
