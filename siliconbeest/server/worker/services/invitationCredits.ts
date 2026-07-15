import { env } from 'cloudflare:workers';
import type { D1PreparedStatement } from '@cloudflare/workers-types';
import { hasStaffCapability } from '../../../../packages/shared/permissions';
import { AppError } from '../middleware/errorHandler';
import { decryptAESGCM, encryptAESGCM, generateToken, sha256 } from '../utils/crypto';
import { generateUlid } from '../utils/ulid';
import { reconcileContributionAwards } from './contribution';
import { getSetting } from './instance';

const DEFAULT_MAX_CREDITS = 999;
const DEFAULT_CONTRIBUTION_THRESHOLD = 100;
const MAX_LINKS_PER_ACCOUNT_PER_DAY = 100;
const MAX_CONSUMED_USES_PER_ACCOUNT_PER_DAY = 2_000;
const UNASSIGNED_CLAIM_TTL_MILLISECONDS = 30 * 60 * 1000;

const LIVE_MAX_CREDITS_SQL = `COALESCE((
	SELECT CAST(value AS INTEGER) FROM settings
	WHERE key = 'invite_credit_max_per_account' LIMIT 1
), ${DEFAULT_MAX_CREDITS})`;

const LIVE_CONTRIBUTION_THRESHOLD_SQL = `MAX(1, COALESCE((
	SELECT CAST(value AS INTEGER) FROM settings
	WHERE key = 'invite_contribution_threshold' LIMIT 1
), ${DEFAULT_CONTRIBUTION_THRESHOLD}))`;

const LIVE_CONTRIBUTION_ENABLED_SQL = `COALESCE((
	SELECT CAST(value AS INTEGER) FROM settings
	WHERE key = 'invite_contribution_enabled' LIMIT 1
), 0) = 1`;

function activeReservedCreditsSql(accountExpression: string): string {
	return `COALESCE((
		SELECT SUM(invitation.remaining_uses)
		FROM registration_invites invitation
		WHERE invitation.inviter_account_id = ${accountExpression}
		  AND invitation.revoked_at IS NULL
	), 0)`;
}

function pendingRefundCreditsSql(accountExpression: string): string {
	return `COALESCE((
		SELECT COUNT(*)
		FROM invitation_use_claims claim
		WHERE claim.inviter_account_id = ${accountExpression}
	), 0)`;
}

function ownershipObligationsSql(accountExpression: string): string {
	return `(${activeReservedCreditsSql(accountExpression)} + ${pendingRefundCreditsSql(accountExpression)})`;
}

function availableCapacitySql(accountExpression: string): string {
	return `MAX(0, ${LIVE_MAX_CREDITS_SQL} - ${ownershipObligationsSql(accountExpression)})`;
}

function liveContributionGrantSql(accountExpression: string): string {
	// contribution_award_level is the lifetime number of credits actually paid,
	// not the tier implied by the current threshold. Threshold increases never
	// claw back or reissue prior awards; only newly earned tiers above that
	// cumulative level can pay out.
	return `CASE WHEN ${LIVE_CONTRIBUTION_ENABLED_SQL} THEN MIN(
		MAX(0, CAST(MAX(contribution_score, 0) / ${LIVE_CONTRIBUTION_THRESHOLD_SQL} AS INTEGER)
		  - contribution_award_level),
		MAX(0, ${LIVE_MAX_CREDITS_SQL} - available_credits
		  - ${ownershipObligationsSql(accountExpression)})
	) ELSE 0 END`;
}

type AuditMetadata = Record<string, string | number | boolean | null>;

interface BalanceRecord {
	account_id: string;
	available_credits: number;
	contribution_score: number;
	contribution_award_level: number;
	last_operation_id: string | null;
	last_credit_delta: number;
	created_at: string;
	updated_at: string;
}

interface InviteRecord {
	id: string;
	inviter_account_id: string;
	remaining_uses: number;
	issued_uses: number;
	revoked_at: string | null;
	reset_at: string | null;
	created_at: string;
}

type InvitationOwnership = {
	reserved_credits: number;
	pending_refund_credits: number;
};

export interface InvitationCreditStatus {
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

export interface InvitationLinkSummary {
	id: string;
	url: string;
	uses_remaining: number;
	issued_uses: number;
	expires_at: string | null;
	auto_follow: boolean;
	revoked_at: string | null;
	created_at: string;
}

export interface CreatedInvitationLink extends InvitationLinkSummary {
	token: string;
}

async function invitationTokenEncryptionKey(): Promise<string> {
	return sha256(`siliconbeest:invitation-token:v1:${env.OTP_ENCRYPTION_KEY}`);
}

async function encryptInvitationToken(token: string): Promise<string> {
	return encryptAESGCM(token, await invitationTokenEncryptionKey());
}

async function decryptInvitationToken(ciphertext: string): Promise<string> {
	return decryptAESGCM(ciphertext, await invitationTokenEncryptionKey());
}

function invitationUrl(token: string): string {
	return `https://${env.INSTANCE_DOMAIN}/?invite=${encodeURIComponent(token)}`;
}

export interface InvitationBalanceSummary {
	account_id: string;
	username: string;
	display_name: string;
	role: string;
	available_credits: number;
	reserved_credits: number;
	pending_refund_credits: number;
	owned_credits: number;
	max_credits: number;
	contribution_score: number;
	contribution_award_level: number;
	updated_at: string | null;
}

export interface PaginatedInvitationBalances {
	accounts: InvitationBalanceSummary[];
	page: number;
	per_page: number;
	limit: number;
	offset: number;
	total: number;
}

export interface InvitationAuditLog {
	id: string;
	actor_account_id: string | null;
	actor_username: string | null;
	target_account_id: string | null;
	target_username: string | null;
	invitation_id: string | null;
	action: string;
	credit_delta: number;
	contribution_delta: number;
	credits_after: number | null;
	contribution_score_after: number | null;
	metadata: AuditMetadata;
	reason: string | null;
	created_at: string;
}

export interface PaginatedInvitationAuditLogs {
	logs: InvitationAuditLog[];
	page: number;
	per_page: number;
	limit: number;
	offset: number;
	total: number;
}

function parseNonNegativeInteger(value: string | null, fallback: number): number {
	if (value === null || !/^\d+$/.test(value)) return fallback;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function isEnabled(value: string | null, fallback: boolean): boolean {
	if (value === null) return fallback;
	return value === '1' || value === 'true';
}

function auditMetadata(value: string): AuditMetadata {
	try {
		const parsed: AuditMetadata = JSON.parse(value);
		return parsed;
	} catch {
		return {};
	}
}

function pagination(pageValue: number, perPageValue: number): { page: number; perPage: number; offset: number } {
	const page = Number.isInteger(pageValue) && pageValue > 0 ? pageValue : 1;
	const perPage = Number.isInteger(perPageValue) && perPageValue > 0
		? Math.min(perPageValue, 100)
		: 50;
	return { page, perPage, offset: (page - 1) * perPage };
}

export function canAdministerInvitations(role: string): boolean {
	return hasStaffCapability(role, 'roles:manage');
}

export async function getInvitationCreditLimit(): Promise<number> {
	return parseNonNegativeInteger(await getSetting('invite_credit_max_per_account'), DEFAULT_MAX_CREDITS);
}

async function contributionThreshold(): Promise<number> {
	return Math.max(1, parseNonNegativeInteger(
		await getSetting('invite_contribution_threshold'),
		DEFAULT_CONTRIBUTION_THRESHOLD,
	));
}

async function ensureBalance(accountId: string): Promise<void> {
	const now = new Date().toISOString();
	await env.DB.prepare(
		`INSERT OR IGNORE INTO account_invitation_balances
		 (account_id, available_credits, contribution_score, contribution_award_level,
		  last_operation_id, last_credit_delta, created_at, updated_at)
		 SELECT accounts.id, 0, 0, 0, NULL, 0, ?1, ?1
		 FROM accounts JOIN users ON users.account_id = accounts.id
		 WHERE accounts.id = ?2 AND accounts.domain IS NULL`,
	).bind(now, accountId).run();
}

async function getBalance(accountId: string): Promise<BalanceRecord> {
	await ensureBalance(accountId);
	const balance = await env.DB.prepare(
		'SELECT * FROM account_invitation_balances WHERE account_id = ?1 LIMIT 1',
	).bind(accountId).first<BalanceRecord>();
	if (!balance) throw new AppError(404, 'Local account not found');
	return balance;
}

async function getInvitationOwnership(accountId: string): Promise<InvitationOwnership> {
	const ownership = await env.DB.prepare(
		`SELECT ${activeReservedCreditsSql('?1')} AS reserved_credits,
		        ${pendingRefundCreditsSql('?1')} AS pending_refund_credits`,
	).bind(accountId).first<InvitationOwnership>();
	return ownership ?? { reserved_credits: 0, pending_refund_credits: 0 };
}

export async function getInvitationCreditStatus(
	accountId: string,
	role: string,
): Promise<InvitationCreditStatus> {
	const [balance, ownership, maxCredits, threshold, contributionSetting, issuanceSetting] = await Promise.all([
		getBalance(accountId),
		getInvitationOwnership(accountId),
		getInvitationCreditLimit(),
		contributionThreshold(),
		getSetting('invite_contribution_enabled'),
		getSetting('invite_link_issuance_enabled'),
	]);
	const contributionEnabled = isEnabled(contributionSetting, false);
	const issuanceEnabled = isEnabled(issuanceSetting, true);
	const permitted = issuanceEnabled || canAdministerInvitations(role);
	return {
		available_credits: balance.available_credits,
		reserved_credits: ownership.reserved_credits,
		pending_refund_credits: ownership.pending_refund_credits,
		owned_credits: balance.available_credits
			+ ownership.reserved_credits
			+ ownership.pending_refund_credits,
		max_credits: maxCredits,
		contribution_score: balance.contribution_score,
		contribution_threshold: threshold,
		contribution_enabled: contributionEnabled,
		issuance_enabled: issuanceEnabled,
		can_issue_links: permitted
			&& balance.available_credits > 0
			&& balance.available_credits
				+ ownership.reserved_credits
				+ ownership.pending_refund_credits <= maxCredits,
	};
}

export async function createInvitationLink(
	actorAccountId: string,
	actorRole: string,
	input: { uses: number; expiresInDays: number | null; autoFollow: boolean },
): Promise<CreatedInvitationLink> {
	const [maxCredits, issuanceSetting] = await Promise.all([
		getInvitationCreditLimit(),
		getSetting('invite_link_issuance_enabled'),
	]);
	if (!isEnabled(issuanceSetting, true) && !canAdministerInvitations(actorRole)) {
		throw new AppError(403, 'Invitation link issuance is currently disabled');
	}
	if (!Number.isInteger(input.uses) || input.uses < 1 || input.uses > maxCredits) {
		throw new AppError(422, 'Validation failed', `uses must be an integer between 1 and ${maxCredits}`);
	}
	if (input.expiresInDays !== null && (
		!Number.isInteger(input.expiresInDays)
		|| input.expiresInDays < 1
		|| input.expiresInDays > 3650
	)) {
		throw new AppError(422, 'Validation failed', 'expires_in_days must be null or an integer between 1 and 3650');
	}

	const id = generateUlid();
	const operationId = generateUlid();
	const auditId = generateUlid();
	const token = generateToken(64);
	const [tokenHash, tokenCiphertext] = await Promise.all([
		sha256(token),
		encryptInvitationToken(token),
	]);
	const now = new Date();
	const nowIso = now.toISOString();
	const issueWindowCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
	const expiresAt = input.expiresInDays === null
		? null
		: new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000).toISOString();
	const metadata = JSON.stringify({
		issued_uses: input.uses,
		expires_at: expiresAt,
		auto_follow: input.autoFollow,
	});
	const adminBypass = canAdministerInvitations(actorRole) ? 1 : 0;
	const issuanceEnabledSql = `COALESCE((
		SELECT value FROM settings WHERE key = 'invite_link_issuance_enabled' LIMIT 1
	), '1') IN ('1', 'true')`;
	const issueOwnershipGuard = `EXISTS (
		SELECT 1 FROM account_invitation_balances balance
		WHERE balance.account_id = ?1
		  AND balance.available_credits >= ?7
		  AND balance.available_credits + ${ownershipObligationsSql('balance.account_id')} <= ${LIVE_MAX_CREDITS_SQL}
	)`;

	await env.DB.batch([
		env.DB.prepare(
			`INSERT OR IGNORE INTO account_invitation_balances
			 (account_id, available_credits, contribution_score, contribution_award_level,
			  last_operation_id, last_credit_delta, created_at, updated_at)
			 SELECT accounts.id, 0, 0, 0, NULL, 0, ?1, ?1
			 FROM accounts JOIN users ON users.account_id = accounts.id
			 WHERE accounts.id = ?2 AND accounts.domain IS NULL`,
		).bind(nowIso, actorAccountId),
		env.DB.prepare(
			`INSERT INTO invitation_link_issue_limits
			 (account_id, window_started_at, issued_links, last_operation_id)
			 SELECT ?1, ?2, 1, ?3
			 WHERE (?6 = 1 OR ${issuanceEnabledSql}) AND ${issueOwnershipGuard}
			 ON CONFLICT(account_id) DO UPDATE SET
			   window_started_at = CASE
			     WHEN window_started_at <= ?4 THEN excluded.window_started_at
			     ELSE window_started_at
			   END,
			   issued_links = CASE
			     WHEN window_started_at <= ?4 THEN 1
			     ELSE issued_links + 1
			   END,
			   last_operation_id = excluded.last_operation_id
			 WHERE (window_started_at <= ?4 OR issued_links < ?5)
			   AND (?6 = 1 OR ${issuanceEnabledSql})
			   AND ${issueOwnershipGuard}`,
		).bind(
			actorAccountId,
			nowIso,
			operationId,
			issueWindowCutoff,
			MAX_LINKS_PER_ACCOUNT_PER_DAY,
			adminBypass,
			input.uses,
		),
		env.DB.prepare(
			`UPDATE account_invitation_balances
			 SET available_credits = available_credits - ?1,
			     last_credit_delta = -?1,
			     last_operation_id = ?2,
			     updated_at = ?3
			 WHERE account_id = ?4 AND available_credits >= ?1
			   AND available_credits + ${ownershipObligationsSql('account_invitation_balances.account_id')}
			       <= ${LIVE_MAX_CREDITS_SQL}
			   AND (?5 = 1 OR ${issuanceEnabledSql})
			   AND EXISTS (
			     SELECT 1 FROM invitation_link_issue_limits
			     WHERE account_id = ?4 AND last_operation_id = ?2
			   )`,
		).bind(input.uses, operationId, nowIso, actorAccountId, adminBypass),
		env.DB.prepare(
			`INSERT INTO registration_invites
			 (id, token_hash, inviter_account_id, remaining_uses, auto_follow, expires_at,
			  revoked_at, created_at, updated_at, issued_uses, revoked_unused_uses,
			  credits_restored_at, credit_operation_id, reset_at, token_ciphertext)
			 SELECT ?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7, ?4, 0, NULL, NULL, NULL, ?9
			 WHERE EXISTS (
			   SELECT 1 FROM account_invitation_balances
			   WHERE account_id = ?3 AND last_operation_id = ?8
			 )`,
		).bind(
			id,
			tokenHash,
			actorAccountId,
			input.uses,
			input.autoFollow ? 1 : 0,
			expiresAt,
			nowIso,
			operationId,
			tokenCiphertext,
		),
		env.DB.prepare(
			`INSERT INTO invitation_audit_logs
			 (id, actor_account_id, target_account_id, invitation_id, action, credit_delta,
			  contribution_delta, credits_after, contribution_score_after, metadata, created_at)
			 SELECT ?1, ?2, ?2, ?3, 'invite.created', balance.last_credit_delta,
			        0, balance.available_credits, balance.contribution_score, ?4, ?5
			 FROM account_invitation_balances balance
			 WHERE balance.account_id = ?2 AND balance.last_operation_id = ?6
			   AND EXISTS (SELECT 1 FROM registration_invites WHERE id = ?3)`,
		).bind(auditId, actorAccountId, id, metadata, nowIso, operationId),
	]);

	const created = await env.DB.prepare(
		`SELECT id, inviter_account_id, remaining_uses, issued_uses, revoked_at, created_at
		 FROM registration_invites WHERE id = ?1 LIMIT 1`,
	).bind(id).first<InviteRecord>();
	if (!created) {
		const issueLimit = await env.DB.prepare(
			`SELECT issued_links, window_started_at, last_operation_id
			 FROM invitation_link_issue_limits WHERE account_id = ?1`,
		).bind(actorAccountId).first<{
			issued_links: number;
			window_started_at: string;
			last_operation_id: string | null;
		}>();
		if (issueLimit
			&& issueLimit.last_operation_id !== operationId
			&& issueLimit.window_started_at > issueWindowCutoff
			&& issueLimit.issued_links >= MAX_LINKS_PER_ACCOUNT_PER_DAY) {
			throw new AppError(429, 'Daily invitation link issuance limit exceeded');
		}
		const liveStatus = await getInvitationCreditStatus(actorAccountId, actorRole);
		if (!liveStatus.issuance_enabled && !canAdministerInvitations(actorRole)) {
			throw new AppError(403, 'Invitation link issuance is currently disabled');
		}
		if (liveStatus.owned_credits > liveStatus.max_credits) {
			throw new AppError(422, 'Invitation ownership exceeds the current account limit');
		}
		throw new AppError(422, 'Insufficient invitation credits',
			`Requested ${input.uses}, available ${liveStatus.available_credits}`);
	}
	await reconcileContributionAwards(actorAccountId).catch(() => undefined);

	return {
		id,
		token,
		url: invitationUrl(token),
		uses_remaining: created.remaining_uses,
		issued_uses: created.issued_uses,
		expires_at: expiresAt,
		auto_follow: input.autoFollow,
		revoked_at: null,
		created_at: created.created_at,
	};
}

export async function listInvitationLinks(accountId: string): Promise<InvitationLinkSummary[]> {
	const { results } = await env.DB.prepare(
		`SELECT id, token_ciphertext, remaining_uses, issued_uses, expires_at, auto_follow,
		        revoked_at, created_at
		 FROM registration_invites
		 WHERE inviter_account_id = ?1 AND revoked_at IS NULL
		 ORDER BY created_at DESC`,
	).bind(accountId).all<{
		id: string;
		token_ciphertext: string;
		remaining_uses: number;
		issued_uses: number;
		expires_at: string | null;
		auto_follow: number;
		revoked_at: string | null;
		created_at: string;
	}>();
	return Promise.all((results ?? []).map(async (record) => {
		const token = await decryptInvitationToken(record.token_ciphertext);
		return {
			id: record.id,
			url: invitationUrl(token),
			uses_remaining: record.remaining_uses,
			issued_uses: record.issued_uses,
			expires_at: record.expires_at,
			auto_follow: record.auto_follow !== 0,
			revoked_at: record.revoked_at,
			created_at: record.created_at,
		};
	}));
}

export async function revokeInvitationLink(
	actorAccountId: string,
	invitationId: string,
): Promise<void> {
	const existing = await env.DB.prepare(
		`SELECT id, inviter_account_id, remaining_uses, issued_uses, revoked_at,
		        reset_at, created_at
		 FROM registration_invites
		 WHERE id = ?1 AND inviter_account_id = ?2 LIMIT 1`,
	).bind(invitationId, actorAccountId).first<InviteRecord>();
	if (!existing || existing.revoked_at) throw new AppError(404, 'Invitation not found');

	const operationId = generateUlid();
	const auditId = generateUlid();
	const now = new Date().toISOString();
	const results = await env.DB.batch([
		env.DB.prepare(
			`UPDATE registration_invites
			 SET revoked_unused_uses = remaining_uses,
			     remaining_uses = 0,
			     revoked_at = ?1,
			     credits_restored_at = ?1,
			     credit_operation_id = ?2,
			     updated_at = ?1
			 WHERE id = ?3 AND inviter_account_id = ?4 AND revoked_at IS NULL`,
		).bind(now, operationId, invitationId, actorAccountId),
		env.DB.prepare(
			`INSERT OR IGNORE INTO account_invitation_balances
			 (account_id, available_credits, contribution_score, contribution_award_level,
			  last_operation_id, last_credit_delta, created_at, updated_at)
			 VALUES (?1, 0, 0, 0, NULL, 0, ?2, ?2)`,
		).bind(actorAccountId, now),
		env.DB.prepare(
			`UPDATE account_invitation_balances
			 SET last_credit_delta = (
			       SELECT revoked_unused_uses FROM registration_invites
			       WHERE id = ?1 AND credit_operation_id = ?2
			     ),
			     available_credits = available_credits + (
			       SELECT revoked_unused_uses FROM registration_invites
			       WHERE id = ?1 AND credit_operation_id = ?2
			     ),
			     last_operation_id = ?2,
			     updated_at = ?3
			 WHERE account_id = ?4
			   AND EXISTS (
			     SELECT 1 FROM registration_invites
			     WHERE id = ?1 AND credit_operation_id = ?2 AND revoked_at = ?3
			   )`,
		).bind(invitationId, operationId, now, actorAccountId),
		env.DB.prepare(
			`INSERT INTO invitation_audit_logs
			 (id, actor_account_id, target_account_id, invitation_id, action, credit_delta,
			  contribution_delta, credits_after, contribution_score_after, metadata, created_at)
			 SELECT ?1, ?2, ?2, ?3, 'invite.revoked', balance.last_credit_delta,
			        0, balance.available_credits, balance.contribution_score,
			        json_object('unused_uses', invitation.revoked_unused_uses), ?4
			 FROM account_invitation_balances balance
			 JOIN registration_invites invitation ON invitation.id = ?3
			 WHERE balance.account_id = ?2 AND balance.last_operation_id = ?5
			   AND invitation.credit_operation_id = ?5`,
		).bind(auditId, actorAccountId, invitationId, now, operationId),
	]);

	if ((results[0]?.meta.changes ?? 0) !== 1) {
		throw new AppError(409, 'Invitation was already revoked');
	}
}

export async function consumeInvitationUse(
	invitationId: string,
	inviterAccountId: string,
): Promise<string | null> {
	await restoreExpiredInvitationClaims();
	const operationId = generateUlid();
	const claimId = generateUlid();
	const nowDate = new Date();
	const now = nowDate.toISOString();
	const windowCutoff = new Date(nowDate.getTime() - 24 * 60 * 60 * 1000).toISOString();
	const claimExpiresAt = new Date(nowDate.getTime() + UNASSIGNED_CLAIM_TTL_MILLISECONDS).toISOString();
	const results = await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO invitation_use_daily_limits
			 (account_id, window_started_at, consumed_uses, last_operation_id)
			 SELECT ?1, ?2, 1, ?3
			 WHERE EXISTS (
			   SELECT 1 FROM registration_invites
			   WHERE id = ?6 AND inviter_account_id = ?1
			     AND remaining_uses > 0 AND revoked_at IS NULL
			     AND (expires_at IS NULL OR expires_at > ?2)
			 )
			 ON CONFLICT(account_id) DO UPDATE SET
			   window_started_at = CASE
			     WHEN window_started_at <= ?4 THEN excluded.window_started_at
			     ELSE window_started_at
			   END,
			   consumed_uses = CASE
			     WHEN window_started_at <= ?4 THEN 1
			     ELSE consumed_uses + 1
			   END,
			   last_operation_id = excluded.last_operation_id
			 WHERE (window_started_at <= ?4 OR consumed_uses < ?5)
			   AND EXISTS (
			     SELECT 1 FROM registration_invites
			     WHERE id = ?6 AND inviter_account_id = ?1
			       AND remaining_uses > 0 AND revoked_at IS NULL
			       AND (expires_at IS NULL OR expires_at > ?2)
			   )`,
		).bind(
			inviterAccountId,
			now,
			operationId,
			windowCutoff,
			MAX_CONSUMED_USES_PER_ACCOUNT_PER_DAY,
			invitationId,
		),
		env.DB.prepare(
			`UPDATE registration_invites
			 SET remaining_uses = remaining_uses - 1,
			     credit_operation_id = ?1,
			     updated_at = ?2
			 WHERE id = ?3 AND inviter_account_id = ?4
			   AND remaining_uses > 0 AND revoked_at IS NULL
			   AND (expires_at IS NULL OR expires_at > ?2)
			   AND EXISTS (
			     SELECT 1 FROM invitation_use_daily_limits
			     WHERE account_id = ?4 AND last_operation_id = ?1
			   )`,
		).bind(operationId, now, invitationId, inviterAccountId),
		env.DB.prepare(
			`INSERT INTO invitation_use_claims
			 (id, invitation_id, inviter_account_id, assigned_user_id, claimed_at, expires_at)
			 SELECT ?1, invitation.id, invitation.inviter_account_id, NULL, ?2, ?3
			 FROM registration_invites invitation
			 WHERE invitation.id = ?4 AND invitation.credit_operation_id = ?5`,
		).bind(claimId, now, claimExpiresAt, invitationId, operationId),
		env.DB.prepare(
			`INSERT INTO invitation_audit_logs
			 (id, actor_account_id, target_account_id, invitation_id, action, credit_delta,
			  contribution_delta, credits_after, contribution_score_after, metadata, created_at)
			 SELECT ?1, NULL, invitation.inviter_account_id, invitation.id, 'invite.used', 0, 0,
			        balance.available_credits, balance.contribution_score,
			        json_object('remaining_uses', invitation.remaining_uses), ?2
			 FROM registration_invites invitation
			 JOIN invitation_use_claims claim
			   ON claim.id = ?5 AND claim.invitation_id = invitation.id
			 LEFT JOIN account_invitation_balances balance
			   ON balance.account_id = invitation.inviter_account_id
			 WHERE invitation.id = ?3 AND invitation.credit_operation_id = ?4`,
		).bind(generateUlid(), now, invitationId, operationId, claimId),
	]);
	if ((results[2]?.meta.changes ?? 0) === 1) return claimId;
	const limit = await env.DB.prepare(
		`SELECT consumed_uses, window_started_at
		 FROM invitation_use_daily_limits WHERE account_id = ?1`,
	).bind(inviterAccountId).first<{ consumed_uses: number; window_started_at: string }>();
	if (limit
		&& limit.window_started_at > windowCutoff
		&& limit.consumed_uses >= MAX_CONSUMED_USES_PER_ACCOUNT_PER_DAY) {
		throw new AppError(429, 'Daily invitation use limit exceeded');
	}
	return null;
}

export async function restoreUnassignedInvitationUse(
	invitationId: string,
	claimId: string,
): Promise<void> {
	await env.DB.batch(invitationRestoreStatements({
		invitationId,
		claimId,
		operationId: generateUlid(),
		now: new Date().toISOString(),
		actionSuffix: 'rollback',
		pendingUserId: null,
	}));
}

export async function invitationCancellationRestoreStatements(
	invitationId: string,
	claimId: string,
	pendingUserId: string,
	expectedState?: 'pending_approval',
	actionSuffix: 'cancelled' | 'expired' | 'rejected' = 'cancelled',
): Promise<D1PreparedStatement[]> {
	return invitationRestoreStatements({
		invitationId,
		claimId,
		operationId: generateUlid(),
		now: new Date().toISOString(),
		actionSuffix,
		pendingUserId,
		expectedState,
	});
}

function invitationRestoreStatements(input: {
	invitationId: string;
	claimId: string;
	operationId: string;
	now: string;
		actionSuffix: 'rollback' | 'cancelled' | 'expired' | 'rejected';
	pendingUserId: string | null;
	expectedState?: 'pending_approval';
}): D1PreparedStatement[] {
	const pendingState = input.expectedState === 'pending_approval'
		? "user.registration_state = 'pending_approval' AND user.approved = 0"
		: "user.registration_state != 'active' OR user.approved = 0";
	const claimGuard = input.pendingUserId === null
		? `EXISTS (
		     SELECT 1 FROM invitation_use_claims claim
		     WHERE claim.id = ?4 AND claim.invitation_id = ?3
		       AND claim.assigned_user_id IS NULL
		   )`
		: `EXISTS (
		     SELECT 1 FROM invitation_use_claims claim
		     JOIN users user ON user.id = claim.assigned_user_id
		     WHERE claim.id = ?4 AND claim.invitation_id = ?3
		       AND claim.assigned_user_id = ?5 AND user.invite_id = ?3
		       AND (${pendingState})
		   )`;
	const mutationBindings = input.pendingUserId === null
		? [input.operationId, input.now, input.invitationId, input.claimId]
		: [input.operationId, input.now, input.invitationId, input.claimId, input.pendingUserId];
	const auditMetadata = `json_object(
		'claim_id', claim.id,
		'reason', '${input.actionSuffix}',
		'claim_expires_at', claim.expires_at,
		'link_was_admin_reset', invitation.reset_at IS NOT NULL,
		'invitee_account_id', (
		  SELECT account_id FROM users WHERE id = claim.assigned_user_id
		)
	)`;
	const cancellationAuditStatements = input.pendingUserId === null
		? []
		: [env.DB.prepare(
			`INSERT INTO invitation_audit_logs
			 (id, actor_account_id, target_account_id, invitation_id, action, credit_delta,
			  contribution_delta, credits_after, contribution_score_after, metadata, created_at)
				 SELECT ?1, NULL, invitation.inviter_account_id, invitation.id, ?2,
				        0, 0, balance.available_credits, balance.contribution_score,
				        ${auditMetadata}, ?3
				 FROM registration_invites invitation
				 JOIN invitation_use_claims claim ON claim.id = ?4 AND claim.invitation_id = invitation.id
				 LEFT JOIN account_invitation_balances balance
				   ON balance.account_id = invitation.inviter_account_id
				 WHERE invitation.id = ?5 AND invitation.credit_operation_id = ?6
				   AND claim.assigned_user_id = ?7`,
		).bind(
			generateUlid(),
			`invite.${input.actionSuffix}`,
			input.now,
			input.claimId,
			input.invitationId,
			input.operationId,
			input.pendingUserId,
		)];
	return [
		env.DB.prepare(
			`UPDATE registration_invites
			 SET remaining_uses = remaining_uses + 1,
			     credit_operation_id = ?1,
			     updated_at = ?2
			 WHERE id = ?3 AND revoked_at IS NULL AND remaining_uses < issued_uses
			   AND ${claimGuard}`,
		).bind(...mutationBindings),
		env.DB.prepare(
			`INSERT INTO invitation_audit_logs
			 (id, actor_account_id, target_account_id, invitation_id, action, credit_delta,
			  contribution_delta, credits_after, contribution_score_after, metadata, created_at)
			 SELECT ?1, NULL, invitation.inviter_account_id, invitation.id, ?2, 0, 0,
			        balance.available_credits, balance.contribution_score, ${auditMetadata}, ?3
			 FROM registration_invites invitation
			 JOIN invitation_use_claims claim ON claim.id = ?6 AND claim.invitation_id = invitation.id
			 LEFT JOIN account_invitation_balances balance
			   ON balance.account_id = invitation.inviter_account_id
			 WHERE invitation.id = ?4 AND invitation.credit_operation_id = ?5
			   AND invitation.revoked_at IS NULL`,
		).bind(
			generateUlid(),
			`invite.use_restored.${input.actionSuffix}`,
			input.now,
			input.invitationId,
			input.operationId,
			input.claimId,
		),
		env.DB.prepare(
			`UPDATE registration_invites
			 SET credit_operation_id = ?1, updated_at = ?2
			 WHERE id = ?3 AND revoked_at IS NOT NULL AND ${claimGuard}`,
		).bind(...mutationBindings),
		env.DB.prepare(
			`INSERT OR IGNORE INTO account_invitation_balances
			 (account_id, available_credits, contribution_score, contribution_award_level,
			  last_operation_id, last_credit_delta, created_at, updated_at)
			 SELECT invitation.inviter_account_id, 0, 0, 0, NULL, 0, ?1, ?1
			 FROM registration_invites invitation
			 JOIN invitation_use_claims claim ON claim.id = ?4 AND claim.invitation_id = invitation.id
			 WHERE invitation.id = ?2 AND invitation.revoked_at IS NOT NULL
			   AND invitation.credit_operation_id = ?3`,
		).bind(input.now, input.invitationId, input.operationId, input.claimId),
		env.DB.prepare(
			`UPDATE account_invitation_balances
			 SET last_credit_delta = 1,
			     available_credits = available_credits + 1,
			     last_operation_id = ?1,
			     updated_at = ?2
			 WHERE account_id = (
			   SELECT invitation.inviter_account_id
			   FROM registration_invites invitation
			   JOIN invitation_use_claims claim
			     ON claim.id = ?4 AND claim.invitation_id = invitation.id
			   WHERE invitation.id = ?3 AND invitation.revoked_at IS NOT NULL
			     AND invitation.credit_operation_id = ?1
			 )`,
		).bind(input.operationId, input.now, input.invitationId, input.claimId),
		env.DB.prepare(
			`INSERT INTO invitation_audit_logs
			 (id, actor_account_id, target_account_id, invitation_id, action, credit_delta,
			  contribution_delta, credits_after, contribution_score_after, metadata, created_at)
			 SELECT ?1, NULL, balance.account_id, invitation.id, ?2,
			        balance.last_credit_delta, 0, balance.available_credits,
			        balance.contribution_score, ${auditMetadata}, ?3
			 FROM account_invitation_balances balance
			 JOIN registration_invites invitation ON invitation.inviter_account_id = balance.account_id
			 JOIN invitation_use_claims claim ON claim.id = ?6 AND claim.invitation_id = invitation.id
			 WHERE invitation.id = ?4 AND invitation.credit_operation_id = ?5
			   AND invitation.revoked_at IS NOT NULL AND balance.last_operation_id = ?5`,
		).bind(
			generateUlid(),
			`invite.revoked_use_restored.${input.actionSuffix}`,
			input.now,
			input.invitationId,
			input.operationId,
			input.claimId,
		),
		...cancellationAuditStatements,
		env.DB.prepare(
			`DELETE FROM invitation_use_claims
			 WHERE id = ?1 AND invitation_id = ?2
			   AND EXISTS (
			     SELECT 1 FROM registration_invites invitation
			     WHERE invitation.id = ?2 AND invitation.credit_operation_id = ?3
			   )`,
		).bind(input.claimId, input.invitationId, input.operationId),
	];
}

export async function restoreExpiredInvitationClaims(limit = 100): Promise<number> {
	const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
	const now = new Date().toISOString();
	const { results } = await env.DB.prepare(
		`SELECT id, invitation_id
		 FROM invitation_use_claims
		 WHERE assigned_user_id IS NULL AND expires_at <= ?1
		 ORDER BY expires_at, id LIMIT ?2`,
	).bind(now, safeLimit).all<{ id: string; invitation_id: string }>();
	let restored = 0;
	for (const claim of results ?? []) {
		const statements = invitationRestoreStatements({
			invitationId: claim.invitation_id,
			claimId: claim.id,
			operationId: generateUlid(),
			now,
			actionSuffix: 'expired',
			pendingUserId: null,
		});
		const restoredResults = await env.DB.batch(statements);
		if ((restoredResults.at(-1)?.meta.changes ?? 0) === 1) restored += 1;
	}
	return restored;
}

async function assertLocalAccount(accountId: string): Promise<void> {
	const account = await env.DB.prepare(
		`SELECT accounts.id
		 FROM accounts JOIN users ON users.account_id = accounts.id
		 WHERE accounts.id = ?1 AND accounts.domain IS NULL LIMIT 1`,
	).bind(accountId).first<{ id: string }>();
	if (!account) throw new AppError(404, 'Local account not found');
}

export async function setInvitationCredits(
	actorAccountId: string,
	targetAccountId: string,
	credits: number,
	reason?: string,
): Promise<InvitationCreditStatus> {
	if (!Number.isSafeInteger(credits) || credits < 0 || credits > 1_000_000_000) {
		throw new AppError(422, 'Validation failed', 'credits must be between 0 and 1000000000');
	}
	await assertLocalAccount(targetAccountId);
	await ensureBalance(targetAccountId);
	const operationId = generateUlid();
	const now = new Date().toISOString();
	const results = await env.DB.batch([
		env.DB.prepare(
			`UPDATE account_invitation_balances
			 SET last_credit_delta = ?1 - available_credits,
			     available_credits = ?1,
			     last_operation_id = ?2,
			     updated_at = ?3
			 WHERE account_id = ?4
			   AND (
			     ?1 <= available_credits
			     OR ?1 + ${ownershipObligationsSql('account_invitation_balances.account_id')}
			        <= ${LIVE_MAX_CREDITS_SQL}
			   )`,
		).bind(credits, operationId, now, targetAccountId),
		auditBalanceOperation(
			generateUlid(), actorAccountId, targetAccountId, 'credits.set', operationId,
			JSON.stringify({ requested_credits: credits, reason: reason ?? null }), now,
		),
	]);
	if ((results[0]?.meta.changes ?? 0) !== 1) {
		throw new AppError(422, 'Invitation credit setting exceeds the account ownership limit');
	}
	return getInvitationCreditStatus(targetAccountId, 'admin');
}

export async function addInvitationCredits(
	actorAccountId: string,
	targetAccountId: string,
	amount: number,
	reason?: string,
): Promise<InvitationCreditStatus> {
	if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000_000) {
		throw new AppError(422, 'Validation failed', 'amount must be a non-zero integer');
	}
	await assertLocalAccount(targetAccountId);
	await ensureBalance(targetAccountId);
	const operationId = generateUlid();
	const now = new Date().toISOString();
	const results = await env.DB.batch([
		env.DB.prepare(
			`UPDATE account_invitation_balances
			 SET available_credits = available_credits + ?1,
			     last_credit_delta = ?1,
			     last_operation_id = ?2,
			     updated_at = ?3
			 WHERE account_id = ?4
			   AND available_credits + ?1 >= 0
			   AND (
			     ?1 < 0
			     OR available_credits + ?1
			        + ${ownershipObligationsSql('account_invitation_balances.account_id')}
			        <= ${LIVE_MAX_CREDITS_SQL}
			   )`,
		).bind(amount, operationId, now, targetAccountId),
		auditBalanceOperation(
			generateUlid(), actorAccountId, targetAccountId, 'credits.adjusted', operationId,
			JSON.stringify({ requested_delta: amount, reason: reason ?? null }), now,
		),
	]);
	if ((results[0]?.meta.changes ?? 0) !== 1) {
		throw new AppError(422, 'Invitation credit adjustment exceeds account limits');
	}
	return getInvitationCreditStatus(targetAccountId, 'admin');
}

export async function updateInvitationSettings(
	actorAccountId: string,
	changes: Readonly<Record<string, string>>,
): Promise<void> {
	const keys = Object.keys(changes).sort();
	if (keys.length === 0) return;
	const now = new Date().toISOString();
	const settingsAuditId = generateUlid();
	const clampOperationId = generateUlid();
	const reconcileOperationId = generateUlid();
	const keyPlaceholders = keys.map((_, index) => `?${index + 6}`).join(', ');
	const statements: D1PreparedStatement[] = [
		env.DB.prepare(
			`INSERT INTO invitation_audit_logs
			 (id, actor_account_id, target_account_id, invitation_id, action, credit_delta,
			  contribution_delta, credits_after, contribution_score_after, metadata, created_at)
			 SELECT ?1, ?2, NULL, NULL, 'settings.updated', 0, 0, NULL, NULL,
			        json_object(
			          'changed_keys', ?3,
			          'before', json(COALESCE((
			            SELECT json_group_object(key, value) FROM settings
			            WHERE key IN (${keyPlaceholders})
			          ), '{}')),
			          'after', json(?4)
			        ), ?5`,
		).bind(
			settingsAuditId,
			actorAccountId,
			keys.join(','),
			JSON.stringify(changes),
			now,
			...keys,
		),
	];

	for (const key of keys) {
		statements.push(env.DB.prepare(
			`INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		).bind(key, changes[key], now));
	}

	if (changes.invite_credit_max_per_account !== undefined) {
		const capacitySql = availableCapacitySql('account_invitation_balances.account_id');
		statements.push(
			env.DB.prepare(
				`UPDATE account_invitation_balances
				 SET last_credit_delta = ${capacitySql} - available_credits,
				     available_credits = ${capacitySql},
				     last_operation_id = ?1,
				     updated_at = ?2
				 WHERE available_credits > ${capacitySql}`,
			).bind(clampOperationId, now),
			env.DB.prepare(
				`INSERT INTO invitation_audit_logs
				 (id, actor_account_id, target_account_id, invitation_id, action, credit_delta,
				  contribution_delta, credits_after, contribution_score_after, metadata, created_at)
				 SELECT lower(hex(randomblob(16))), ?1, balance.account_id, NULL,
				        'credits.cap_clamped', balance.last_credit_delta, 0,
				        balance.available_credits, balance.contribution_score,
				        json_object(
				          'new_limit', ${LIVE_MAX_CREDITS_SQL},
				          'ownership_obligations', ${ownershipObligationsSql('balance.account_id')}
				        ), ?2
				 FROM account_invitation_balances balance
				 WHERE balance.last_operation_id = ?3`,
			).bind(actorAccountId, now, clampOperationId),
		);
	}

	const reconciliationTriggers: string[] = [];
	if (changes.invite_contribution_enabled === '1') {
		reconciliationTriggers.push(
			`COALESCE(json_extract(setting_audit.metadata,
			  '$.before.invite_contribution_enabled'), '0') != '1'`,
		);
	}
	if (changes.invite_contribution_threshold !== undefined) {
		reconciliationTriggers.push(
			`${Number(changes.invite_contribution_threshold)} < COALESCE(CAST(json_extract(
			  setting_audit.metadata, '$.before.invite_contribution_threshold'
			) AS INTEGER), ${DEFAULT_CONTRIBUTION_THRESHOLD})`,
		);
	}
	if (changes.invite_credit_max_per_account !== undefined) {
		reconciliationTriggers.push(
			`${Number(changes.invite_credit_max_per_account)} > COALESCE(CAST(json_extract(
			  setting_audit.metadata, '$.before.invite_credit_max_per_account'
			) AS INTEGER), ${DEFAULT_MAX_CREDITS})`,
		);
	}
	if (reconciliationTriggers.length > 0) {
		const grantSql = liveContributionGrantSql('account_invitation_balances.account_id');
		statements.push(
			env.DB.prepare(
				`UPDATE account_invitation_balances
				 SET last_credit_delta = ${grantSql},
				     available_credits = available_credits + ${grantSql},
				     contribution_award_level = contribution_award_level + ${grantSql},
				     last_operation_id = ?1,
				     updated_at = ?2
				 WHERE ${grantSql} > 0
				   AND EXISTS (
				     SELECT 1 FROM invitation_audit_logs setting_audit
				     WHERE setting_audit.id = ?3
				       AND (${reconciliationTriggers.join(' OR ')})
				   )`,
			).bind(reconcileOperationId, now, settingsAuditId),
			env.DB.prepare(
				`INSERT INTO invitation_audit_logs
				 (id, actor_account_id, target_account_id, invitation_id, action, credit_delta,
				  contribution_delta, credits_after, contribution_score_after, metadata, created_at)
				 SELECT lower(hex(randomblob(16))), NULL, balance.account_id, NULL,
				        'contribution.tier_awarded', balance.last_credit_delta, 0,
				        balance.available_credits, balance.contribution_score,
				        json_object(
				          'source', 'settings_reconciliation',
				          'threshold', ${LIVE_CONTRIBUTION_THRESHOLD_SQL},
				          'from_award_level', balance.contribution_award_level - balance.last_credit_delta,
				          'to_award_level', balance.contribution_award_level
				        ), ?1
				 FROM account_invitation_balances balance
				 WHERE balance.last_operation_id = ?2 AND balance.last_credit_delta > 0`,
			).bind(now, reconcileOperationId),
		);
	}

	await env.DB.batch(statements);
}

function auditBalanceOperation(
	id: string,
	actorAccountId: string | null,
	targetAccountId: string,
	action: string,
	operationId: string,
	metadata: string,
	createdAt: string,
): D1PreparedStatement {
	return env.DB.prepare(
		`INSERT INTO invitation_audit_logs
		 (id, actor_account_id, target_account_id, invitation_id, action, credit_delta,
		  contribution_delta, credits_after, contribution_score_after, metadata, created_at)
		 SELECT ?1, ?2, balance.account_id, NULL, ?3, balance.last_credit_delta, 0,
		        balance.available_credits, balance.contribution_score, ?4, ?5
		 FROM account_invitation_balances balance
		 WHERE balance.account_id = ?6 AND balance.last_operation_id = ?7`,
	).bind(id, actorAccountId, action, metadata, createdAt, targetAccountId, operationId);
}

export async function distributeInvitationCredits(
	actorAccountId: string,
	accountIds: string[] | null,
	amount = 1,
): Promise<{ targeted_accounts: number; credited_accounts: number; credits_added: number }> {
	if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000_000) {
		throw new AppError(422, 'Validation failed', 'amount must be a positive integer');
	}
	if (accountIds !== null && (accountIds.length === 0 || accountIds.length > 500)) {
		throw new AppError(422, 'account_ids must contain between 1 and 500 account IDs');
	}
	const uniqueIds = accountIds === null ? null : [...new Set(accountIds)];
	const operationId = generateUlid();
	const now = new Date().toISOString();
	const selection = uniqueIds === null
		? 'accounts.domain IS NULL'
		: `accounts.domain IS NULL AND accounts.id IN (${uniqueIds.map(() => '?').join(', ')})`;
	const bindings = uniqueIds ?? [];
	const balanceSelection = uniqueIds === null
		? `account_id IN (
		     SELECT accounts.id FROM accounts JOIN users ON users.account_id = accounts.id
		     WHERE accounts.domain IS NULL
		   )`
		: `account_id IN (${uniqueIds?.map(() => '?').join(', ')})`;

	await env.DB.batch([
		env.DB.prepare(
			`INSERT OR IGNORE INTO account_invitation_balances
			 (account_id, available_credits, contribution_score, contribution_award_level,
			  last_operation_id, last_credit_delta, created_at, updated_at)
			 SELECT accounts.id, 0, 0, 0, NULL, 0, ?1, ?1
			 FROM accounts JOIN users ON users.account_id = accounts.id
			 WHERE ${selection}`,
		).bind(now, ...bindings),
		env.DB.prepare(
			`UPDATE account_invitation_balances
			 SET last_credit_delta = MIN(
			       ?1,
			       MAX(0, ${LIVE_MAX_CREDITS_SQL} - available_credits
			         - ${ownershipObligationsSql('account_invitation_balances.account_id')})
			     ),
			     available_credits = available_credits + MIN(
			       ?1,
			       MAX(0, ${LIVE_MAX_CREDITS_SQL} - available_credits
			         - ${ownershipObligationsSql('account_invitation_balances.account_id')})
			     ),
			     last_operation_id = ?2,
			     updated_at = ?3
			 WHERE ${balanceSelection}
			   AND available_credits + ${ownershipObligationsSql('account_invitation_balances.account_id')}
			       < ${LIVE_MAX_CREDITS_SQL}`,
		).bind(amount, operationId, now, ...bindings),
		env.DB.prepare(
			`INSERT INTO invitation_audit_logs
			 (id, actor_account_id, target_account_id, invitation_id, action, credit_delta,
			  contribution_delta, credits_after, contribution_score_after, metadata, created_at)
			 SELECT lower(hex(randomblob(16))), ?1, balance.account_id, NULL, 'credits.distributed',
			        balance.last_credit_delta, 0, balance.available_credits,
			        balance.contribution_score, json_object('requested_delta', ?2), ?3
			 FROM account_invitation_balances balance
			 WHERE balance.last_operation_id = ?4`,
		).bind(actorAccountId, amount, now, operationId),
	]);

	const summary = await env.DB.prepare(
		`SELECT COUNT(*) AS targeted_accounts,
		        SUM(CASE WHEN last_credit_delta > 0 THEN 1 ELSE 0 END) AS credited_accounts,
		        COALESCE(SUM(last_credit_delta), 0) AS credits_added
		 FROM account_invitation_balances WHERE last_operation_id = ?1`,
	).bind(operationId).first<{
		targeted_accounts: number;
		credited_accounts: number;
		credits_added: number;
	}>();
	return summary ?? { targeted_accounts: 0, credited_accounts: 0, credits_added: 0 };
}

export async function resetAllInvitationCredits(
	actorAccountId: string,
	confirmation: string,
): Promise<{
	reset_accounts: number;
	available_credits_removed: number;
	discarded_link_uses: number;
	credits_removed: number;
}> {
	if (confirmation !== 'RESET_ALL_INVITATION_CREDITS') {
		throw new AppError(422, 'Explicit reset confirmation is required');
	}
	return resetInvitationCredits(actorAccountId, null);
}

export async function resetInvitationCredits(
	actorAccountId: string,
	accountIds: string[] | null,
): Promise<{
	reset_accounts: number;
	available_credits_removed: number;
	discarded_link_uses: number;
	credits_removed: number;
}> {
	if (accountIds !== null && (accountIds.length === 0 || accountIds.length > 500)) {
		throw new AppError(422, 'account_ids must contain between 1 and 500 account IDs');
	}
	const uniqueIds = accountIds === null ? null : [...new Set(accountIds)];
	const operationId = generateUlid();
	const now = new Date().toISOString();
	const accountSelection = uniqueIds === null
		? 'accounts.domain IS NULL'
		: `accounts.domain IS NULL AND accounts.id IN (${uniqueIds.map(() => '?').join(', ')})`;
	const balanceSelection = uniqueIds === null
		? `account_id IN (
		     SELECT accounts.id FROM accounts JOIN users ON users.account_id = accounts.id
		     WHERE accounts.domain IS NULL
		   )`
		: `account_id IN (${uniqueIds?.map(() => '?').join(', ')})`;
	const invitationSelection = uniqueIds === null
		? `inviter_account_id IN (
		     SELECT accounts.id FROM accounts JOIN users ON users.account_id = accounts.id
		     WHERE accounts.domain IS NULL
		   )`
		: `inviter_account_id IN (${uniqueIds?.map(() => '?').join(', ')})`;
	const bindings = uniqueIds ?? [];
	await env.DB.batch([
		env.DB.prepare(
			`INSERT OR IGNORE INTO account_invitation_balances
			 (account_id, available_credits, contribution_score, contribution_award_level,
			  last_operation_id, last_credit_delta, created_at, updated_at)
			 SELECT accounts.id, 0, 0, 0, NULL, 0, ?1, ?1
			 FROM accounts JOIN users ON users.account_id = accounts.id
			 WHERE ${accountSelection}`,
		).bind(now, ...bindings),
		env.DB.prepare(
			`INSERT INTO invitation_audit_logs
			 (id, actor_account_id, target_account_id, invitation_id, action, credit_delta,
			  contribution_delta, credits_after, contribution_score_after, metadata, created_at)
			 SELECT lower(hex(randomblob(16))), ?1, balance.account_id, NULL, 'credits.reset',
			        -balance.available_credits, 0, 0, balance.contribution_score,
			        json_object(
			          'dangerous_operation', 1,
			          'reset_operation_id', ?3,
			          'revoked_links', (
			            SELECT COUNT(*) FROM registration_invites invitation
			            WHERE invitation.inviter_account_id = balance.account_id
			              AND invitation.revoked_at IS NULL
			          ),
			          'discarded_link_uses', ${activeReservedCreditsSql('balance.account_id')},
			          'pending_refund_obligations', ${pendingRefundCreditsSql('balance.account_id')}
			        ), ?2
			 FROM account_invitation_balances balance
			 WHERE ${balanceSelection}`,
		).bind(actorAccountId, now, operationId, ...bindings),
		env.DB.prepare(
			`INSERT INTO invitation_audit_logs
			 (id, actor_account_id, target_account_id, invitation_id, action, credit_delta,
			  contribution_delta, credits_after, contribution_score_after, metadata, created_at)
			 SELECT lower(hex(randomblob(16))), ?1, invitation.inviter_account_id,
			        invitation.id, 'invite.reset', 0, 0, balance.available_credits,
			        balance.contribution_score,
			        json_object('discarded_uses', invitation.remaining_uses), ?2
			 FROM registration_invites invitation
			 LEFT JOIN account_invitation_balances balance
			   ON balance.account_id = invitation.inviter_account_id
			 WHERE ${invitationSelection} AND invitation.revoked_at IS NULL`,
		).bind(actorAccountId, now, ...bindings),
		env.DB.prepare(
			`UPDATE registration_invites
			 SET revoked_unused_uses = CASE
			       WHEN revoked_at IS NULL THEN remaining_uses
			       ELSE revoked_unused_uses
			     END,
			     remaining_uses = CASE WHEN revoked_at IS NULL THEN 0 ELSE remaining_uses END,
			     revoked_at = COALESCE(revoked_at, ?1),
			     reset_at = ?1,
			     credits_restored_at = CASE WHEN revoked_at IS NULL THEN NULL ELSE credits_restored_at END,
			     credit_operation_id = ?2,
			     updated_at = ?1
			 WHERE ${invitationSelection}`,
		).bind(now, operationId, ...bindings),
		env.DB.prepare(
			`UPDATE account_invitation_balances
			 SET last_credit_delta = -available_credits,
			     available_credits = 0,
			     last_operation_id = ?1,
			     updated_at = ?2
			 WHERE ${balanceSelection}`,
		).bind(operationId, now, ...bindings),
	]);
	const summary = await env.DB.prepare(
		`SELECT COUNT(*) AS reset_accounts,
		        COALESCE(-SUM(credit_delta), 0) AS available_credits_removed,
		        COALESCE(SUM(CAST(json_extract(metadata, '$.discarded_link_uses') AS INTEGER)), 0)
		          AS discarded_link_uses
		 FROM invitation_audit_logs
		 WHERE action = 'credits.reset'
		   AND json_extract(metadata, '$.reset_operation_id') = ?1`,
	).bind(operationId).first<{
		reset_accounts: number;
		available_credits_removed: number;
		discarded_link_uses: number;
	}>();
	const result = summary ?? {
		reset_accounts: 0,
		available_credits_removed: 0,
		discarded_link_uses: 0,
	};
	return {
		...result,
		credits_removed: result.available_credits_removed + result.discarded_link_uses,
	};
}

export async function listInvitationBalances(
	pageValue: number,
	perPageValue: number,
	query: string | null,
	offsetOverride?: number,
): Promise<PaginatedInvitationBalances> {
	const paginationValues = pagination(pageValue, perPageValue);
	const { page, perPage } = paginationValues;
	const offset = offsetOverride !== undefined && Number.isSafeInteger(offsetOverride) && offsetOverride >= 0
		? offsetOverride
		: paginationValues.offset;
	const search = query?.trim() ? `%${query.trim().toLowerCase()}%` : null;
	const where = search === null
		? 'accounts.domain IS NULL'
		: `accounts.domain IS NULL
		   AND (LOWER(accounts.username) LIKE ?1 OR LOWER(accounts.display_name) LIKE ?1)`;
	const countBindings = search === null ? [] : [search];
	const listBindings = search === null
		? [perPage, offset]
		: [search, perPage, offset];
	const limitParameter = search === null ? '?1' : '?2';
	const offsetParameter = search === null ? '?2' : '?3';
	const [count, rows, maxCredits] = await Promise.all([
		env.DB.prepare(
			`SELECT COUNT(*) AS total
			 FROM accounts JOIN users ON users.account_id = accounts.id
			 WHERE ${where}`,
		).bind(...countBindings).first<{ total: number }>(),
		env.DB.prepare(
			`SELECT accounts.id AS account_id, accounts.username, accounts.display_name, users.role,
			        COALESCE(balance.available_credits, 0) AS available_credits,
			        ${activeReservedCreditsSql('accounts.id')} AS reserved_credits,
			        ${pendingRefundCreditsSql('accounts.id')} AS pending_refund_credits,
			        COALESCE(balance.available_credits, 0)
			          + ${activeReservedCreditsSql('accounts.id')}
			          + ${pendingRefundCreditsSql('accounts.id')} AS owned_credits,
			        COALESCE(balance.contribution_score, 0) AS contribution_score,
			        COALESCE(balance.contribution_award_level, 0) AS contribution_award_level,
			        balance.updated_at
			 FROM accounts JOIN users ON users.account_id = accounts.id
			 LEFT JOIN account_invitation_balances balance ON balance.account_id = accounts.id
			 WHERE ${where}
			 ORDER BY LOWER(accounts.username), accounts.id
			 LIMIT ${limitParameter} OFFSET ${offsetParameter}`,
		).bind(...listBindings).all<InvitationBalanceSummary>(),
		getInvitationCreditLimit(),
	]);
	return {
		accounts: (rows.results ?? []).map((account) => ({ ...account, max_credits: maxCredits })),
		page,
		per_page: perPage,
		limit: perPage,
		offset,
		total: count?.total ?? 0,
	};
}

export async function listInvitationAuditLogs(
	pageValue: number,
	perPageValue: number,
	filters: { action: string | null; accountId: string | null },
	offsetOverride?: number,
): Promise<PaginatedInvitationAuditLogs> {
	const paginationValues = pagination(pageValue, perPageValue);
	const { page, perPage } = paginationValues;
	const offset = offsetOverride !== undefined && Number.isSafeInteger(offsetOverride) && offsetOverride >= 0
		? offsetOverride
		: paginationValues.offset;
	const conditions: string[] = [];
	const values: string[] = [];
	if (filters.action) {
		values.push(filters.action);
		conditions.push(`action = ?${values.length}`);
	}
	if (filters.accountId) {
		values.push(filters.accountId);
		conditions.push(`(actor_account_id = ?${values.length} OR target_account_id = ?${values.length})`);
	}
	const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
	const count = await env.DB.prepare(
		`SELECT COUNT(*) AS total FROM invitation_audit_logs ${where}`,
	).bind(...values).first<{ total: number }>();
	const limitParameter = values.length + 1;
	const offsetParameter = values.length + 2;
	const { results } = await env.DB.prepare(
		`SELECT log.*, actor.username AS actor_username, target.username AS target_username,
		        json_extract(log.metadata, '$.reason') AS reason
		 FROM invitation_audit_logs log
		 LEFT JOIN accounts actor ON actor.id = log.actor_account_id
		 LEFT JOIN accounts target ON target.id = log.target_account_id
		 ${where ? where.replaceAll('action', 'log.action').replaceAll('actor_account_id', 'log.actor_account_id').replaceAll('target_account_id', 'log.target_account_id') : ''}
		 ORDER BY log.created_at DESC, log.id DESC
		 LIMIT ?${limitParameter} OFFSET ?${offsetParameter}`,
	).bind(...values, perPage, offset).all<{
		id: string;
		actor_account_id: string | null;
		actor_username: string | null;
		target_account_id: string | null;
		target_username: string | null;
		invitation_id: string | null;
		action: string;
		credit_delta: number;
		contribution_delta: number;
		credits_after: number | null;
		contribution_score_after: number | null;
		metadata: string;
		reason: string | null;
		created_at: string;
	}>();
	return {
		logs: (results ?? []).map((row) => ({ ...row, metadata: auditMetadata(row.metadata) })),
		page,
		per_page: perPage,
		limit: perPage,
		offset,
		total: count?.total ?? 0,
	};
}
