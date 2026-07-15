import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	adjustContributionScore,
	reconcileContributionAwards,
	recordContributionEvent,
} from '../../server/worker/services/contribution';
import { classifyContributionEvent } from '../../server/worker/middleware/contribution';
import { applyMigration, authHeaders, createTestUser } from './helpers';

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

type BalanceRow = {
	available_credits: number;
	contribution_score: number;
	contribution_award_level: number;
};

type AuditRow = {
	actor_account_id: string | null;
	action: string;
	credit_delta: number;
	contribution_delta: number;
	metadata: string;
};

const BASE = 'https://test.siliconbeest.local';

async function setContributionSettings(entries: Readonly<Record<string, string>>): Promise<void> {
	const now = new Date().toISOString();
	await env.DB.batch(Object.entries(entries).map(([key, value]) =>
		env.DB.prepare(
			`INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		).bind(key, value, now),
	));
}

async function getBalance(accountId: string): Promise<BalanceRow> {
	const row = await env.DB.prepare(
		`SELECT available_credits, contribution_score, contribution_award_level
		 FROM account_invitation_balances WHERE account_id = ?1`,
	).bind(accountId).first<BalanceRow>();
	if (!row) throw new Error('Expected contribution balance');
	return row;
}

async function getAudits(accountId: string): Promise<AuditRow[]> {
	const { results } = await env.DB.prepare(
		`SELECT actor_account_id, action, credit_delta, contribution_delta, metadata
		 FROM invitation_audit_logs WHERE target_account_id = ?1 ORDER BY created_at, id`,
	).bind(accountId).all<AuditRow>();
	return results ?? [];
}

describe('contribution scoring', () => {
	let member: TestUser;
	let admin: TestUser;
	let moderator: TestUser;
	let reportTarget: TestUser;

	beforeAll(async () => {
		await applyMigration();
		member = await createTestUser('contribution-member');
		admin = await createTestUser('contribution-admin', { role: 'admin' });
		moderator = await createTestUser('contribution-moderator', { role: 'moderator' });
		reportTarget = await createTestUser('contribution-report-target');
	});

	beforeEach(async () => {
		await env.DB.prepare('DELETE FROM invitation_audit_logs').run();
		await env.DB.prepare('DELETE FROM account_invitation_balances').run();
		await setContributionSettings({
			invite_contribution_enabled: '0',
			invite_contribution_threshold: '100',
			invite_credit_max_per_account: '999',
			invite_contribution_points_status_create: '0',
			invite_contribution_points_status_delete: '0',
			invite_contribution_points_status_favourite: '0',
			invite_contribution_points_status_reblog: '0',
			invite_contribution_points_status_bookmark: '0',
			invite_contribution_points_list_create: '0',
			invite_contribution_points_generic_mutation: '0',
		});
	});

	it('does not score activities while automatic contribution processing is disabled', async () => {
		await setContributionSettings({ invite_contribution_points_status_create: '250' });

		const result = await recordContributionEvent(member.accountId, 'status_create');

		expect(result).toEqual({ processed: false, reason: 'disabled' });
		const balance = await env.DB.prepare(
			'SELECT account_id FROM account_invitation_balances WHERE account_id = ?1',
		).bind(member.accountId).first<{ account_id: string }>();
		expect(balance).toBeNull();
	});

	it('awards every newly crossed positive tier and writes score and award audits', async () => {
		await setContributionSettings({
			invite_contribution_enabled: '1',
			invite_contribution_points_status_create: '250',
		});

		const result = await recordContributionEvent(member.accountId, 'status_create', {
			requestId: 'request-1',
			method: 'POST',
			path: '/api/v1/statuses',
		});

		expect(result).toMatchObject({
			processed: true,
			availableCredits: 2,
			contributionScore: 250,
			contributionAwardLevel: 2,
			creditsAwarded: 2,
		});
		expect(await getBalance(member.accountId)).toEqual({
			available_credits: 2,
			contribution_score: 250,
			contribution_award_level: 2,
		});

		const audits = await getAudits(member.accountId);
		expect(audits).toHaveLength(2);
		const scoreAudit = audits.find((audit) => audit.action === 'contribution.adjusted');
		const awardAudit = audits.find((audit) => audit.action === 'contribution.tier_awarded');
		expect(scoreAudit).toMatchObject({
			actor_account_id: null,
			action: 'contribution.adjusted',
			credit_delta: 0,
			contribution_delta: 250,
		});
		expect(JSON.parse(scoreAudit!.metadata)).toMatchObject({
			event: 'status_create',
			request_id: 'request-1',
		});
		expect(awardAudit).toMatchObject({
			action: 'contribution.tier_awarded',
			credit_delta: 2,
			contribution_delta: 0,
		});
	});

	it('allows negative scores without revoking credits or previously awarded tiers', async () => {
		await setContributionSettings({
			invite_contribution_enabled: '1',
			invite_contribution_points_status_create: '100',
			invite_contribution_points_status_delete: '-175',
		});
		await recordContributionEvent(member.accountId, 'status_create');

		const result = await recordContributionEvent(member.accountId, 'status_delete');

		expect(result).toMatchObject({
			processed: true,
			availableCredits: 1,
			contributionScore: -75,
			contributionAwardLevel: 1,
			creditsAwarded: 0,
		});
	});

	it('keeps capped tiers pending and awards them after credits are spent', async () => {
		await setContributionSettings({
			invite_contribution_enabled: '1',
			invite_credit_max_per_account: '1',
			invite_contribution_points_status_create: '250',
		});
		await recordContributionEvent(member.accountId, 'status_create');
		expect(await getBalance(member.accountId)).toMatchObject({
			available_credits: 1,
			contribution_score: 250,
			contribution_award_level: 1,
		});

		await env.DB.prepare(
			'UPDATE account_invitation_balances SET available_credits = 0 WHERE account_id = ?1',
		).bind(member.accountId).run();
		const reconciled = await reconcileContributionAwards(member.accountId);

		expect(reconciled).toMatchObject({
			availableCredits: 1,
			contributionScore: 250,
			contributionAwardLevel: 2,
			creditsAwarded: 1,
		});
	});

	it('immediately reconciles already-earned tiers when an administrator enables awards', async () => {
		await adjustContributionScore({
			targetAccountId: member.accountId,
			actorAccountId: admin.accountId,
			delta: 250,
			reason: 'Seed disabled contribution balance',
		});
		expect(await getBalance(member.accountId)).toMatchObject({
			available_credits: 0,
			contribution_score: 250,
			contribution_award_level: 0,
		});

		const enabled = await SELF.fetch(`${BASE}/api/v1/admin/settings`, {
			method: 'PATCH',
			headers: authHeaders(admin.token),
			body: JSON.stringify({ invite_contribution_enabled: '1' }),
		});
		expect(enabled.status).toBe(200);
		expect(await getBalance(member.accountId)).toMatchObject({
			available_credits: 2,
			contribution_score: 250,
			contribution_award_level: 2,
		});
		expect((await getAudits(member.accountId)).map((audit) => audit.action))
			.toContain('contribution.tier_awarded');
	});

	it('keeps the lifetime paid award level when the threshold increases', async () => {
		await setContributionSettings({
			invite_contribution_enabled: '1',
			invite_contribution_threshold: '100',
			invite_contribution_points_status_create: '500',
		});
		await recordContributionEvent(member.accountId, 'status_create');
		expect(await getBalance(member.accountId)).toMatchObject({
			available_credits: 5,
			contribution_score: 500,
			contribution_award_level: 5,
		});

		await setContributionSettings({ invite_contribution_threshold: '1000' });
		const belowNextLifetimeTier = await adjustContributionScore({
			targetAccountId: member.accountId,
			actorAccountId: admin.accountId,
			delta: 5000,
		});
		expect(belowNextLifetimeTier).toMatchObject({
			availableCredits: 5,
			contributionScore: 5500,
			contributionAwardLevel: 5,
			creditsAwarded: 0,
		});
		const nextLifetimeTier = await adjustContributionScore({
			targetAccountId: member.accountId,
			actorAccountId: admin.accountId,
			delta: 500,
		});
		expect(nextLifetimeTier).toMatchObject({
			availableCredits: 6,
			contributionScore: 6000,
			contributionAwardLevel: 6,
			creditsAwarded: 1,
		});
	});

	it('records an admin adjustment while automatic scoring is disabled', async () => {
		const result = await adjustContributionScore({
			targetAccountId: member.accountId,
			actorAccountId: admin.accountId,
			delta: -25,
			reason: 'Confirmed abuse report',
			source: 'report_resolution',
			referenceId: 'report-1',
		});

		expect(result).toMatchObject({
			contributionScore: -25,
			availableCredits: 0,
			contributionAwardLevel: 0,
		});
		const audits = await getAudits(member.accountId);
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({
			actor_account_id: admin.accountId,
			action: 'contribution.adjusted',
			contribution_delta: -25,
		});
	});

	it('classifies the finite mutation taxonomy and excludes sensitive flows', () => {
		expect(classifyContributionEvent('POST', '/api/v1/statuses')).toBe('status_create');
		expect(classifyContributionEvent('POST', '/api/v1/statuses', true)).toBe('reply_create');
		expect(classifyContributionEvent('POST', '/api/v1/statuses/1/favourite')).toBe('status_favourite');
		expect(classifyContributionEvent('POST', '/api/v1/polls/1/votes')).toBe('poll_vote');
		expect(classifyContributionEvent('PATCH', '/api/v1/preferences')).toBe('generic_mutation');
		expect(classifyContributionEvent('POST', '/api/v1/auth/login')).toBeNull();
		expect(classifyContributionEvent('POST', '/api/v1/invites')).toBeNull();
		expect(classifyContributionEvent('PATCH', '/api/v1/admin/settings')).toBeNull();
		expect(classifyContributionEvent('GET', '/api/v1/statuses/1')).toBeNull();
	});

	it('scores a successful authenticated route exactly once and ignores failed requests', async () => {
		await setContributionSettings({
			invite_contribution_enabled: '1',
			invite_contribution_points_list_create: '10',
		});

		const successful = await SELF.fetch(`${BASE}/api/v1/lists`, {
			method: 'POST',
			headers: authHeaders(member.token),
			body: JSON.stringify({ title: 'Contributors' }),
		});
		expect(successful.status).toBe(200);
		expect(await getBalance(member.accountId)).toMatchObject({ contribution_score: 10 });

		const failed = await SELF.fetch(`${BASE}/api/v1/lists`, {
			method: 'POST',
			headers: authHeaders(member.token),
			body: JSON.stringify({}),
		});
		expect(failed.status).toBe(422);
		expect(await getBalance(member.accountId)).toMatchObject({ contribution_score: 10 });
		expect(await getAudits(member.accountId)).toHaveLength(1);
	});

	it('does not score repeated idempotent status interactions', async () => {
		await setContributionSettings({
			invite_contribution_enabled: '1',
			invite_contribution_points_status_favourite: '10',
			invite_contribution_points_status_reblog: '10',
			invite_contribution_points_status_bookmark: '10',
		});
		const created = await SELF.fetch(`${BASE}/api/v1/statuses`, {
			method: 'POST',
			headers: authHeaders(reportTarget.token),
			body: JSON.stringify({ status: 'A contribution idempotency target', visibility: 'public' }),
		});
		expect(created.status).toBe(200);
		const status = await created.json<{ id: string }>();
		const paths = [
			`/api/v1/statuses/${status.id}/favourite`,
			`/api/v1/statuses/${status.id}/reblog`,
			`/api/v1/statuses/${status.id}/bookmark`,
		];
		for (const path of paths) {
			const first = await SELF.fetch(`${BASE}${path}`, {
				method: 'POST',
				headers: authHeaders(member.token),
			});
			expect(first.status).toBe(200);
			const repeated = await SELF.fetch(`${BASE}${path}`, {
				method: 'POST',
				headers: authHeaders(member.token),
			});
			expect(repeated.status).toBe(200);
		}

		expect(await getBalance(member.accountId)).toMatchObject({ contribution_score: 30 });
		expect((await getAudits(member.accountId)).filter(
			(audit) => audit.action === 'contribution.adjusted',
		)).toHaveLength(3);
	});

	it('scores a generic preference mutation only when a value changes', async () => {
		await setContributionSettings({
			invite_contribution_enabled: '1',
			invite_contribution_points_generic_mutation: '10',
		});
		await env.DB.prepare(
			"DELETE FROM user_preferences WHERE user_id = ?1 AND key = 'ui:columns'",
		).bind(member.userId).run();

		const request = () => SELF.fetch(`${BASE}/api/v1/preferences`, {
			method: 'PATCH',
			headers: authHeaders(member.token),
			body: JSON.stringify({ 'ui:columns': 'advanced' }),
		});
		expect((await request()).status).toBe(200);
		expect((await request()).status).toBe(200);

		expect(await getBalance(member.accountId)).toMatchObject({ contribution_score: 10 });
		expect((await getAudits(member.accountId)).filter(
			(audit) => audit.action === 'contribution.adjusted',
		)).toHaveLength(1);
	});

	it('scores a generic mutation only when the persisted state changes', async () => {
		await setContributionSettings({
			invite_contribution_enabled: '1',
			invite_contribution_points_generic_mutation: '10',
		});
		const created = await SELF.fetch(`${BASE}/api/v1/lists`, {
			method: 'POST',
			headers: authHeaders(member.token),
			body: JSON.stringify({ title: 'Generic mutation guard' }),
		});
		expect(created.status).toBe(200);
		const list = await created.json<{ id: string }>();

		for (const title of ['Generic mutation guard', 'Updated title', 'Updated title']) {
			const response = await SELF.fetch(`${BASE}/api/v1/lists/${list.id}`, {
				method: 'PUT',
				headers: authHeaders(member.token),
				body: JSON.stringify({ title }),
			});
			expect(response.status).toBe(200);
		}

		expect(await getBalance(member.accountId)).toMatchObject({ contribution_score: 10 });
		expect((await getAudits(member.accountId)).filter(
			(audit) => audit.action === 'contribution.adjusted',
		)).toHaveLength(1);
	});

	it('does not score a push preference update that persists the same values', async () => {
		await setContributionSettings({
			invite_contribution_enabled: '1',
			invite_contribution_points_generic_mutation: '10',
		});
		const token = await env.DB.prepare(
			'SELECT id FROM oauth_access_tokens WHERE user_id = ?1 LIMIT 1',
		).bind(member.userId).first<{ id: string }>();
		if (!token) throw new Error('Expected test access token');
		const now = new Date().toISOString();
		await env.DB.prepare(
			`INSERT INTO web_push_subscriptions
			 (id, user_id, access_token_id, endpoint, key_p256dh, key_auth, policy, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'all', ?7, ?7)`,
		).bind(
			crypto.randomUUID(), member.userId, token.id, 'https://push.test/subscription',
			'p256dh', 'auth', now,
		).run();

		for (const policy of ['all', 'none', 'none']) {
			const response = await SELF.fetch(`${BASE}/api/v1/push/subscription`, {
				method: 'PUT',
				headers: authHeaders(member.token),
				body: JSON.stringify({ data: { policy } }),
			});
			expect(response.status).toBe(200);
		}

		expect(await getBalance(member.accountId)).toMatchObject({ contribution_score: 10 });
		expect((await getAudits(member.accountId)).filter(
			(audit) => audit.action === 'contribution.adjusted',
		)).toHaveLength(1);
	});

	it('supports a one-time typed contribution adjustment while resolving a report', async () => {
		const created = await SELF.fetch(`${BASE}/api/v1/reports`, {
			method: 'POST',
			headers: authHeaders(member.token),
			body: JSON.stringify({ account_id: reportTarget.accountId, comment: 'Actionable report' }),
		});
		expect(created.status).toBe(200);
		const report = await created.json<{ id: string }>();
		const unrelatedAdjustment = await SELF.fetch(
			`${BASE}/api/v1/admin/reports/${report.id}/resolve`,
			{
				method: 'POST',
				headers: authHeaders(admin.token),
				body: JSON.stringify({
					contribution_adjustment: { account_id: member.accountId, points: 15 },
				}),
			},
		);
		expect(unrelatedAdjustment.status).toBe(422);
		expect(await env.DB.prepare(
			'SELECT action_taken_at FROM reports WHERE id = ?1',
		).bind(report.id).first<{ action_taken_at: string | null }>()).toEqual({ action_taken_at: null });

		const resolved = await SELF.fetch(`${BASE}/api/v1/admin/reports/${report.id}/resolve`, {
			method: 'POST',
			headers: authHeaders(admin.token),
			body: JSON.stringify({
				contribution_adjustment: {
					account_id: reportTarget.accountId,
					points: 15,
					reason: 'Confirmed report',
				},
			}),
		});
		expect(resolved.status).toBe(200);
		expect(await resolved.clone().json<{ contribution_adjustment_applied: boolean }>())
			.toMatchObject({ contribution_adjustment_applied: true });
		expect(await getBalance(reportTarget.accountId)).toMatchObject({ contribution_score: 15 });

		const repeated = await SELF.fetch(`${BASE}/api/v1/admin/reports/${report.id}/resolve`, {
			method: 'POST',
			headers: authHeaders(admin.token),
			body: JSON.stringify({ contribution_adjustment: { points: 15 } }),
		});
		expect(repeated.status).toBe(200);
		expect(await repeated.json<{ contribution_adjustment_applied: boolean }>())
			.toMatchObject({ contribution_adjustment_applied: false });
		expect(await getBalance(reportTarget.accountId)).toMatchObject({ contribution_score: 15 });
	});

	it('rolls report resolution back when the contribution adjustment fails', async () => {
		const created = await SELF.fetch(`${BASE}/api/v1/reports`, {
			method: 'POST',
			headers: authHeaders(member.token),
			body: JSON.stringify({ account_id: reportTarget.accountId, comment: 'Retryable report' }),
		});
		expect(created.status).toBe(200);
		const report = await created.json<{ id: string }>();
		const now = new Date().toISOString();
		await env.DB.prepare(
			`INSERT INTO account_invitation_balances
			 (account_id, available_credits, contribution_score, contribution_award_level, created_at, updated_at)
			 VALUES (?1, 0, ?2, 0, ?3, ?3)`,
		).bind(reportTarget.accountId, Number.MAX_SAFE_INTEGER, now).run();

		const failed = await SELF.fetch(`${BASE}/api/v1/admin/reports/${report.id}/resolve`, {
			method: 'POST',
			headers: authHeaders(admin.token),
			body: JSON.stringify({ contribution_adjustment: { points: 1 } }),
		});
		expect(failed.status).toBe(503);
		expect(await env.DB.prepare(
			`SELECT action_taken, action_taken_at, action_taken_by_account_id
			 FROM reports WHERE id = ?1`,
		).bind(report.id).first<{
			action_taken: number;
			action_taken_at: string | null;
			action_taken_by_account_id: string | null;
		}>()).toEqual({
			action_taken: 0,
			action_taken_at: null,
			action_taken_by_account_id: null,
		});

		await env.DB.prepare(
			'UPDATE account_invitation_balances SET contribution_score = 0 WHERE account_id = ?1',
		).bind(reportTarget.accountId).run();
		const retried = await SELF.fetch(`${BASE}/api/v1/admin/reports/${report.id}/resolve`, {
			method: 'POST',
			headers: authHeaders(admin.token),
			body: JSON.stringify({ contribution_adjustment: { points: 1 } }),
		});
		expect(retried.status).toBe(200);
		expect(await getBalance(reportTarget.accountId)).toMatchObject({ contribution_score: 1 });
	});

	it('does not let moderators adjust contribution scores while resolving reports', async () => {
		const created = await SELF.fetch(`${BASE}/api/v1/reports`, {
			method: 'POST',
			headers: authHeaders(member.token),
			body: JSON.stringify({ account_id: reportTarget.accountId, comment: 'Admin-only adjustment' }),
		});
		expect(created.status).toBe(200);
		const report = await created.json<{ id: string }>();

		const response = await SELF.fetch(`${BASE}/api/v1/admin/reports/${report.id}/resolve`, {
			method: 'POST',
			headers: authHeaders(moderator.token),
			body: JSON.stringify({ contribution_adjustment: { points: 1_000_000_000 } }),
		});
		expect(response.status).toBe(403);
		const persisted = await env.DB.prepare(
			'SELECT action_taken_at FROM reports WHERE id = ?1',
		).bind(report.id).first<{ action_taken_at: string | null }>();
		expect(persisted?.action_taken_at).toBeNull();
	});
});
