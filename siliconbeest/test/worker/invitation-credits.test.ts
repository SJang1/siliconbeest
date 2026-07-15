import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { consumeRegistrationInvitation } from '../../server/worker/services/registration';
import { applyMigration, authHeaders, createTestUser } from './helpers';

const BASE = 'https://test.siliconbeest.local';

interface CreditStatus {
	available_credits: number;
	reserved_credits: number;
	pending_refund_credits: number;
	owned_credits: number;
	max_credits: number;
	contribution_score: number;
	contribution_threshold: number;
	contribution_enabled: boolean;
	issuance_enabled: boolean;
	can_issue_links: boolean;
}

interface CreatedInvite {
	id: string;
	token: string;
	url: string;
	uses_remaining: number;
	issued_uses: number;
	revoked_at: string | null;
}

interface ListedInvite {
	id: string;
	url: string;
}

interface AuditResponse {
	logs: Array<{
		action: string;
		credit_delta: number;
		target_account_id: string | null;
		invitation_id: string | null;
	}>;
	page: number;
	per_page: number;
	total: number;
}

let migrated = false;
let sequence = 0;

async function settings(values: Record<string, string>) {
	const now = new Date().toISOString();
	await env.DB.batch(Object.entries(values).map(([key, value]) => env.DB.prepare(
		`INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
		 ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3`,
	).bind(key, value, now)));
}

async function adminSetCredits(adminToken: string, accountId: string, credits: number) {
	return SELF.fetch(`${BASE}/api/v1/admin/invitation-credits/${accountId}`, {
		method: 'POST',
		headers: authHeaders(adminToken),
		body: JSON.stringify({ operation: 'set', amount: credits }),
	});
}

async function createInvite(token: string, uses: number): Promise<Response> {
	return SELF.fetch(`${BASE}/api/v1/invites`, {
		method: 'POST',
		headers: authHeaders(token),
		body: JSON.stringify({ uses, expires_in_days: 7, auto_follow: true }),
	});
}

async function registerWithInvite(username: string, inviteToken: string): Promise<Response> {
	sequence += 1;
	return SELF.fetch(`${BASE}/api/v1/accounts`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'CF-Connecting-IP': `203.0.113.${sequence}`,
		},
		body: JSON.stringify({
			username,
			email: `${username}@test.local`,
			password: 'securepassword123',
			agreement: true,
			locale: 'en',
			invite_token: inviteToken,
		}),
	});
}

function registrationCookie(response: Response): string {
	const value = response.headers.get('set-cookie')
		?.match(/(?:^|,\s*)siliconbeest_registration=([^;,]+)/)?.[1];
	expect(value).toBeTruthy();
	return `siliconbeest_registration=${value ?? ''}`;
}

describe('invitation credit ledger', () => {
	beforeEach(async () => {
		if (!migrated) {
			await applyMigration();
			migrated = true;
		}
		await settings({
			registration_mode: 'open',
			require_email_verification: '0',
			invite_credit_max_per_account: '999',
			invite_link_issuance_enabled: '1',
			invite_contribution_enabled: '0',
			invite_contribution_threshold: '100',
		});
	});

	it('defaults to zero, deducts link uses exactly, and records the mutations', async () => {
		const admin = await createTestUser(`credit_admin_${sequence++}`, { role: 'admin' });
		const user = await createTestUser(`credit_user_${sequence++}`);

		const initial = await SELF.fetch(`${BASE}/api/v1/invites/credits`, {
			headers: authHeaders(user.token),
		});
		expect(initial.status).toBe(200);
		expect(await initial.json<CreditStatus>()).toMatchObject({
			available_credits: 0,
			max_credits: 999,
			can_issue_links: false,
		});
		expect((await createInvite(user.token, 1)).status).toBe(422);

		const granted = await adminSetCredits(admin.token, user.accountId, 5);
		expect(granted.status).toBe(200);
		expect((await granted.json<CreditStatus>()).available_credits).toBe(5);

		const response = await createInvite(user.token, 3);
		expect(response.status).toBe(200);
		const invitation = await response.json<CreatedInvite>();
		expect(invitation).toMatchObject({ uses_remaining: 3, issued_uses: 3, revoked_at: null });

		const balance = await SELF.fetch(`${BASE}/api/v1/invites/credits`, {
			headers: authHeaders(user.token),
		});
		expect((await balance.json<CreditStatus>()).available_credits).toBe(2);

		const audit = await SELF.fetch(
			`${BASE}/api/v1/admin/invitation-audit-logs?limit=50&offset=0`,
			{ headers: authHeaders(admin.token) },
		);
		const logs = await audit.json<AuditResponse>();
		expect(logs.logs.map((log) => log.action)).toEqual(expect.arrayContaining([
			'credits.set',
			'invite.created',
		]));
		expect(logs.logs.find((log) => log.action === 'invite.created')?.credit_delta).toBe(-3);
	});

	it('keeps active invitation URLs available across repeated list requests', async () => {
		const admin = await createTestUser(`persistent_admin_${sequence++}`, { role: 'admin' });
		const inviter = await createTestUser(`persistent_inviter_${sequence++}`);
		expect((await adminSetCredits(admin.token, inviter.accountId, 1)).status).toBe(200);
		const created = await (await createInvite(inviter.token, 1)).json<CreatedInvite>();

		const first = await SELF.fetch(`${BASE}/api/v1/invites`, {
			headers: authHeaders(inviter.token),
		});
		const second = await SELF.fetch(`${BASE}/api/v1/invites`, {
			headers: authHeaders(inviter.token),
		});
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect((await first.json<ListedInvite[]>())[0]).toMatchObject({
			id: created.id,
			url: created.url,
		});
		expect((await second.json<ListedInvite[]>())[0]?.url).toBe(created.url);
	});

	it('blocks user issuance globally while preserving the admin bypass', async () => {
		const admin = await createTestUser(`disabled_admin_${sequence++}`, { role: 'admin' });
		const user = await createTestUser(`disabled_user_${sequence++}`);
		expect((await adminSetCredits(admin.token, user.accountId, 1)).status).toBe(200);
		expect((await adminSetCredits(admin.token, admin.accountId, 1)).status).toBe(200);
		await settings({ invite_link_issuance_enabled: '0' });

		expect((await createInvite(user.token, 1)).status).toBe(403);
		expect((await createInvite(admin.token, 1)).status).toBe(200);
	});

	it('bounds refunded link churn with an account-scoped daily issuance limit', async () => {
		const admin = await createTestUser(`limit_admin_${sequence++}`, { role: 'admin' });
		const user = await createTestUser(`limit_user_${sequence++}`);
		expect((await adminSetCredits(admin.token, user.accountId, 1)).status).toBe(200);
		await env.DB.prepare(
			`INSERT INTO invitation_link_issue_limits
			 (account_id, window_started_at, issued_links, last_operation_id)
			 VALUES (?1, ?2, 100, NULL)`,
		).bind(user.accountId, new Date().toISOString()).run();

		const response = await createInvite(user.token, 1);
		expect(response.status).toBe(429);
		const balance = await SELF.fetch(`${BASE}/api/v1/invites/credits`, {
			headers: authHeaders(user.token),
		});
		expect((await balance.json<CreditStatus>()).available_credits).toBe(1);
	});

	it('restores only unused uses once when a link is revoked', async () => {
		const admin = await createTestUser(`revoke_admin_${sequence++}`, { role: 'admin' });
		const inviter = await createTestUser(`revoke_inviter_${sequence++}`);
		expect((await adminSetCredits(admin.token, inviter.accountId, 5)).status).toBe(200);
		const created = await createInvite(inviter.token, 3);
		const invite = await created.json<CreatedInvite>();

		const registration = await registerWithInvite(`revoke_join_${sequence++}`, invite.token);
		expect(registration.status).toBe(200);
		const revoke = await SELF.fetch(`${BASE}/api/v1/invites/${invite.id}`, {
			method: 'DELETE',
			headers: authHeaders(inviter.token),
		});
		expect(revoke.status).toBe(200);
		expect((await createInvite(inviter.token, 5)).status).toBe(422);

		const balance = await SELF.fetch(`${BASE}/api/v1/invites/credits`, {
			headers: authHeaders(inviter.token),
		});
		expect((await balance.json<CreditStatus>()).available_credits).toBe(4);
		const repeated = await SELF.fetch(`${BASE}/api/v1/invites/${invite.id}`, {
			method: 'DELETE',
			headers: authHeaders(inviter.token),
		});
		expect(repeated.status).toBe(404);
		const preview = await SELF.fetch(`${BASE}/api/v1/registration/invitations/${invite.token}`);
		expect(preview.status).toBe(410);
	});

	it('returns a cancelled use to the account after revocation, not to the link', async () => {
		const admin = await createTestUser(`cancel_admin_${sequence++}`, { role: 'admin' });
		const inviter = await createTestUser(`cancel_inviter_${sequence++}`);
		expect((await adminSetCredits(admin.token, inviter.accountId, 2)).status).toBe(200);
		const created = await createInvite(inviter.token, 2);
		const invite = await created.json<CreatedInvite>();
		const registration = await registerWithInvite(`cancel_join_${sequence++}`, invite.token);
		expect(registration.status).toBe(200);
		const cookie = registrationCookie(registration);

		expect((await SELF.fetch(`${BASE}/api/v1/invites/${invite.id}`, {
			method: 'DELETE',
			headers: authHeaders(inviter.token),
		})).status).toBe(200);
		const cancellation = await SELF.fetch(`${BASE}/api/v1/registration/cancel`, {
			method: 'POST',
			headers: { Cookie: cookie },
		});
		expect(cancellation.status).toBe(200);

		const link = await env.DB.prepare(
			'SELECT remaining_uses, revoked_at FROM registration_invites WHERE id = ?1',
		).bind(invite.id).first<{ remaining_uses: number; revoked_at: string | null }>();
		expect(link?.remaining_uses).toBe(0);
		expect(link?.revoked_at).toBeTruthy();
		const balance = await SELF.fetch(`${BASE}/api/v1/invites/credits`, {
			headers: authHeaders(inviter.token),
		});
		expect((await balance.json<CreditStatus>()).available_credits).toBe(2);
	});

	it('returns a cancelled use to an active link without creating account credit', async () => {
		const admin = await createTestUser(`active_cancel_admin_${sequence++}`, { role: 'admin' });
		const inviter = await createTestUser(`active_cancel_inviter_${sequence++}`);
		expect((await adminSetCredits(admin.token, inviter.accountId, 1)).status).toBe(200);
		const invite = await (await createInvite(inviter.token, 1)).json<CreatedInvite>();
		const registration = await registerWithInvite(`active_cancel_join_${sequence++}`, invite.token);
		expect(registration.status).toBe(200);
		const cancellation = await SELF.fetch(`${BASE}/api/v1/registration/cancel`, {
			method: 'POST',
			headers: { Cookie: registrationCookie(registration) },
		});
		expect(cancellation.status).toBe(200);

		const link = await env.DB.prepare(
			'SELECT remaining_uses, revoked_at FROM registration_invites WHERE id = ?1',
		).bind(invite.id).first<{ remaining_uses: number; revoked_at: string | null }>();
		expect(link).toEqual({ remaining_uses: 1, revoked_at: null });
		const status = await SELF.fetch(`${BASE}/api/v1/invites/credits`, {
			headers: authHeaders(inviter.token),
		});
		expect((await status.json<CreditStatus>()).available_credits).toBe(0);
	});

	it('distributes credits, requires explicit reset confirmation, and keeps audit admin-only', async () => {
		const admin = await createTestUser(`bulk_admin_${sequence++}`, { role: 'admin' });
		const firstUsername = `bulk_first_${sequence++}`;
		const first = await createTestUser(firstUsername);
		const second = await createTestUser(`bulk_second_${sequence++}`);
		const ordinary = await createTestUser(`bulk_ordinary_${sequence++}`);

		const distributed = await SELF.fetch(`${BASE}/api/v1/admin/invitation-credits/distribute`, {
			method: 'POST',
			headers: authHeaders(admin.token),
			body: JSON.stringify({ account_ids: [first.accountId, second.accountId] }),
		});
		expect(distributed.status).toBe(200);
		expect(await distributed.json()).toMatchObject({ updated: 2 });
		const list = await SELF.fetch(
			`${BASE}/api/v1/admin/invitation-credits?search=${encodeURIComponent(firstUsername)}&limit=1&offset=0`,
			{ headers: authHeaders(admin.token) },
		);
		expect(list.status).toBe(200);
		expect(await list.json<{
			accounts: Array<{ account_id: string; role: string; max_credits: number }>;
			limit: number;
			offset: number;
		}>()).toMatchObject({
			accounts: [{ account_id: first.accountId, role: 'user', max_credits: 999 }],
			limit: 1,
			offset: 0,
		});

		const unsafeReset = await SELF.fetch(`${BASE}/api/v1/admin/invitation-credits/reset`, {
			method: 'POST',
			headers: authHeaders(admin.token),
			body: JSON.stringify({ confirmation: 'yes' }),
		});
		expect(unsafeReset.status).toBe(422);
		const reset = await SELF.fetch(`${BASE}/api/v1/admin/invitation-credits/reset`, {
			method: 'POST',
			headers: authHeaders(admin.token),
			body: JSON.stringify({ account_ids: [first.accountId], confirmation: 'RESET' }),
		});
		expect(reset.status).toBe(200);
		expect(await reset.json()).toEqual({ updated: 1 });
		const secondStatus = await SELF.fetch(`${BASE}/api/v1/invites/credits`, {
			headers: authHeaders(second.token),
		});
		expect((await secondStatus.json<CreditStatus>()).available_credits).toBe(1);

		const forbidden = await SELF.fetch(`${BASE}/api/v1/admin/invitation-audit-logs`, {
			headers: authHeaders(ordinary.token),
		});
		expect(forbidden.status).toBe(403);
		const audit = await SELF.fetch(`${BASE}/api/v1/admin/invitation-audit-logs?limit=2&offset=0`, {
			headers: authHeaders(admin.token),
		});
		expect(audit.status).toBe(200);
		expect(await audit.json<AuditResponse>()).toMatchObject({ page: 1, per_page: 2 });
	});

	it('validates invite settings and audits cap reductions', async () => {
		const admin = await createTestUser(`cap_admin_${sequence++}`, { role: 'admin' });
		const user = await createTestUser(`cap_user_${sequence++}`);
		expect((await adminSetCredits(admin.token, user.accountId, 5)).status).toBe(200);
		const contribution = await SELF.fetch(
			`${BASE}/api/v1/admin/invitation-credits/${user.accountId}`,
			{
				method: 'POST',
				headers: authHeaders(admin.token),
				body: JSON.stringify({ operation: 'contribution', amount: -25, reason: 'moderation' }),
			},
		);
		expect(contribution.status).toBe(200);
		expect((await contribution.json<CreditStatus>()).contribution_score).toBe(-25);

		const invalid = await SELF.fetch(`${BASE}/api/v1/admin/settings`, {
			method: 'PATCH',
			headers: authHeaders(admin.token),
			body: JSON.stringify({ invite_link_issuance_enabled: 'sometimes' }),
		});
		expect(invalid.status).toBe(422);
		const update = await SELF.fetch(`${BASE}/api/v1/admin/settings`, {
			method: 'PATCH',
			headers: authHeaders(admin.token),
			body: JSON.stringify({ invite_credit_max_per_account: '2' }),
		});
		expect(update.status).toBe(200);

		const status = await SELF.fetch(`${BASE}/api/v1/invites/credits`, {
			headers: authHeaders(user.token),
		});
		expect(await status.json<CreditStatus>()).toMatchObject({
			available_credits: 2,
			max_credits: 2,
		});
		const auditRows = await env.DB.prepare(
			`SELECT action, credit_delta FROM invitation_audit_logs
			 WHERE target_account_id = ?1 OR actor_account_id = ?2`,
		).bind(user.accountId, admin.accountId).all<{ action: string; credit_delta: number }>();
		expect((auditRows.results ?? []).map((row) => row.action)).toEqual(expect.arrayContaining([
			'credits.cap_clamped',
			'settings.updated',
		]));
		expect((auditRows.results ?? [])
			.filter((row) => row.action === 'credits.cap_clamped')
			.map((row) => row.credit_delta)).toContain(-3);
	});

	it('counts active link reservations in the ownership cap and never loses an exact revoke refund', async () => {
		const admin = await createTestUser(`owned_admin_${sequence++}`, { role: 'admin' });
		const inviter = await createTestUser(`owned_inviter_${sequence++}`);
		await settings({ invite_credit_max_per_account: '5' });
		expect((await adminSetCredits(admin.token, inviter.accountId, 5)).status).toBe(200);
		const first = await (await createInvite(inviter.token, 3)).json<CreatedInvite>();

		let status = await (await SELF.fetch(`${BASE}/api/v1/invites/credits`, {
			headers: authHeaders(inviter.token),
		})).json<CreditStatus>();
		expect(status).toMatchObject({
			available_credits: 2,
			reserved_credits: 3,
			pending_refund_credits: 0,
			owned_credits: 5,
		});
		const overCapGrant = await SELF.fetch(
			`${BASE}/api/v1/admin/invitation-credits/${inviter.accountId}`,
			{
				method: 'POST',
				headers: authHeaders(admin.token),
				body: JSON.stringify({ operation: 'add', amount: 1 }),
			},
		);
		expect(overCapGrant.status).toBe(422);
		expect((await createInvite(inviter.token, 2)).status).toBe(200);

		expect((await SELF.fetch(`${BASE}/api/v1/admin/settings`, {
			method: 'PATCH',
			headers: authHeaders(admin.token),
			body: JSON.stringify({ invite_credit_max_per_account: '2' }),
		})).status).toBe(200);
		status = await (await SELF.fetch(`${BASE}/api/v1/invites/credits`, {
			headers: authHeaders(inviter.token),
		})).json<CreditStatus>();
		expect(status).toMatchObject({
			available_credits: 0,
			reserved_credits: 5,
			owned_credits: 5,
			max_credits: 2,
			can_issue_links: false,
		});

		expect((await SELF.fetch(`${BASE}/api/v1/invites/${first.id}`, {
			method: 'DELETE',
			headers: authHeaders(inviter.token),
		})).status).toBe(200);
		status = await (await SELF.fetch(`${BASE}/api/v1/invites/credits`, {
			headers: authHeaders(inviter.token),
		})).json<CreditStatus>();
		expect(status).toMatchObject({
			available_credits: 3,
			reserved_credits: 2,
			owned_credits: 5,
			max_credits: 2,
		});
	});

	it('keeps consumed claims refundable after an administrator reset', async () => {
		const admin = await createTestUser(`reset_claim_admin_${sequence++}`, { role: 'admin' });
		const inviter = await createTestUser(`reset_claim_inviter_${sequence++}`);
		expect((await adminSetCredits(admin.token, inviter.accountId, 2)).status).toBe(200);
		const invite = await (await createInvite(inviter.token, 2)).json<CreatedInvite>();
		const registration = await registerWithInvite(`reset_claim_join_${sequence++}`, invite.token);
		expect(registration.status).toBe(200);

		let status = await (await SELF.fetch(`${BASE}/api/v1/invites/credits`, {
			headers: authHeaders(inviter.token),
		})).json<CreditStatus>();
		expect(status).toMatchObject({
			available_credits: 0,
			reserved_credits: 1,
			pending_refund_credits: 1,
			owned_credits: 2,
		});

		const reset = await SELF.fetch(`${BASE}/api/v1/admin/invitation-credits/reset`, {
			method: 'POST',
			headers: authHeaders(admin.token),
			body: JSON.stringify({ account_ids: [inviter.accountId], confirmation: 'RESET' }),
		});
		expect(reset.status).toBe(200);
		const resetLink = await env.DB.prepare(
			`SELECT remaining_uses, revoked_at, reset_at FROM registration_invites WHERE id = ?1`,
		).bind(invite.id).first<{
			remaining_uses: number;
			revoked_at: string | null;
			reset_at: string | null;
		}>();
		expect(resetLink).toMatchObject({ remaining_uses: 0 });
		expect(resetLink?.revoked_at).toBeTruthy();
		expect(resetLink?.reset_at).toBeTruthy();

		expect((await SELF.fetch(`${BASE}/api/v1/registration/cancel`, {
			method: 'POST',
			headers: { Cookie: registrationCookie(registration) },
		})).status).toBe(200);
		status = await (await SELF.fetch(`${BASE}/api/v1/invites/credits`, {
			headers: authHeaders(inviter.token),
		})).json<CreditStatus>();
		expect(status).toMatchObject({
			available_credits: 1,
			reserved_credits: 0,
			pending_refund_credits: 0,
			owned_credits: 1,
		});
		expect((await env.DB.prepare(
			`SELECT action FROM invitation_audit_logs WHERE invitation_id = ?1`,
		).bind(invite.id).all<{ action: string }>()).results.map((row) => row.action))
			.toEqual(expect.arrayContaining([
				'invite.reset',
				'invite.cancelled',
				'invite.revoked_use_restored.cancelled',
			]));
	});

	it('restores an expired unassigned claim before invitation usability is checked', async () => {
		const admin = await createTestUser(`orphan_admin_${sequence++}`, { role: 'admin' });
		const inviter = await createTestUser(`orphan_inviter_${sequence++}`);
		expect((await adminSetCredits(admin.token, inviter.accountId, 1)).status).toBe(200);
		const invite = await (await createInvite(inviter.token, 1)).json<CreatedInvite>();
		const consumed = await consumeRegistrationInvitation(invite.token);
		expect(consumed.claim_id).toBeTruthy();
		await env.DB.prepare(
			`UPDATE invitation_use_claims SET expires_at = ?1 WHERE id = ?2`,
		).bind('2000-01-01T00:00:00.000Z', consumed.claim_id).run();

		const preview = await SELF.fetch(`${BASE}/api/v1/registration/invitations/${invite.token}`);
		expect(preview.status).toBe(200);
		expect(await preview.json<{ uses_remaining: number }>()).toMatchObject({ uses_remaining: 1 });
		expect(await env.DB.prepare(
			'SELECT id FROM invitation_use_claims WHERE id = ?1',
		).bind(consumed.claim_id).first<{ id: string }>()).toBeNull();
	});

	it('bounds consume and cancel audit churn with the account daily consume limit', async () => {
		const admin = await createTestUser(`consume_limit_admin_${sequence++}`, { role: 'admin' });
		const inviter = await createTestUser(`consume_limit_inviter_${sequence++}`);
		expect((await adminSetCredits(admin.token, inviter.accountId, 1)).status).toBe(200);
		const invite = await (await createInvite(inviter.token, 1)).json<CreatedInvite>();
		await env.DB.prepare(
			`INSERT INTO invitation_use_daily_limits
			 (account_id, window_started_at, consumed_uses, last_operation_id)
			 VALUES (?1, ?2, 2000, NULL)`,
		).bind(inviter.accountId, new Date().toISOString()).run();

		const registration = await registerWithInvite(`consume_limited_${sequence++}`, invite.token);
		expect(registration.status).toBe(429);
		expect(await env.DB.prepare(
			'SELECT remaining_uses FROM registration_invites WHERE id = ?1',
		).bind(invite.id).first<{ remaining_uses: number }>()).toEqual({ remaining_uses: 1 });
		expect(await env.DB.prepare(
			'SELECT COUNT(*) AS count FROM invitation_use_claims WHERE invitation_id = ?1',
		).bind(invite.id).first<{ count: number }>()).toEqual({ count: 0 });
	});
});
