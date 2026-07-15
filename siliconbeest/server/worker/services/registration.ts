import { env } from 'cloudflare:workers';
import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { RegistrationDesign, RegistrationState } from '../types/db';
import { AppError } from '../middleware/errorHandler';
import { generateToken, sha256 } from '../utils/crypto';
import { generateUlid } from '../utils/ulid';
import { getSetting } from './instance';
import { sendConfirmation, sendWelcome } from './email';
import {
	consumeInvitationUse,
	createInvitationLink,
	invitationCancellationRestoreStatements,
	listInvitationLinks,
	restoreExpiredInvitationClaims,
	restoreUnassignedInvitationUse,
	revokeInvitationLink,
} from './invitationCredits';
import { reconcileContributionAwards } from './contribution';

export type RegistrationMode = 'open' | 'approval' | 'referral' | 'closed';

const REGISTRATION_CANCELLATION_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface RegistrationInviter {
	id: string;
	username: string;
	acct: string;
	display_name: string;
	avatar: string | null;
	avatar_static: string | null;
}

export interface RegistrationStatus {
	state: RegistrationState;
	username: string;
	email: string;
	invited_by: RegistrationInviter | null;
	email_verification_required: boolean;
	email_verification_expires_at: string | null;
	redirect_uri: string;
}

export interface RegistrationInvitePreview {
	id: string;
	/** Internal one-use claim, present only after a successful consume. */
	claim_id?: string;
	inviter: RegistrationInviter;
	uses_remaining: number;
	expires_at: string | null;
	auto_follow: boolean;
}

export interface RegistrationInviteSummary {
	id: string;
	url: string;
	uses_remaining: number;
	issued_uses: number;
	expires_at: string | null;
	auto_follow: boolean;
	revoked_at: string | null;
	created_at: string;
}

export interface CreatedRegistrationInvite extends RegistrationInviteSummary {
	token: string;
	url: string;
}

export async function assertRegistrationCancellationCooldown(email: string): Promise<void> {
	const emailHash = await sha256(email.trim().toLowerCase());
	const now = new Date().toISOString();
	const cooldown = await env.DB.prepare(
		`SELECT expires_at
		 FROM registration_cancellation_cooldowns
		 WHERE email_hash = ?1 LIMIT 1`,
	).bind(emailHash).first<{ expires_at: string }>();
	if (!cooldown) return;
	if (cooldown.expires_at > now) {
		throw new AppError(
			429,
			'Registration cancellation cooldown is active',
			'You can register again 24 hours after cancelling your previous registration.',
		);
	}
	await env.DB.prepare(
		'DELETE FROM registration_cancellation_cooldowns WHERE email_hash = ?1 AND expires_at <= ?2',
	).bind(emailHash, now).run();
}

interface RegistrationInviteRecord {
	id: string;
	token_hash: string;
	inviter_account_id: string;
	remaining_uses: number;
	auto_follow: number;
	expires_at: string | null;
	revoked_at: string | null;
	created_at: string;
	updated_at: string;
	inviter_username: string;
	inviter_display_name: string;
	inviter_avatar_url: string | null;
	inviter_avatar_static_url: string | null;
}

interface RegistrationStatusRecord {
	user_id: string;
	account_id: string;
	email: string;
	locale: string;
	registration_state: RegistrationState;
	registration_redirect_uri: string | null;
	confirmation_token: string | null;
	email_verification_expires_at: string | null;
	username: string;
	invited_by_account_id: string | null;
	inviter_username: string | null;
	inviter_display_name: string | null;
	inviter_avatar_url: string | null;
	inviter_avatar_static_url: string | null;
}

interface RegistrationActivationRecord {
	user_id: string;
	account_id: string;
	email: string;
	locale: string;
	registration_state: RegistrationState;
	registration_redirect_uri: string | null;
	registration_design: RegistrationDesign;
	confirmation_token: string | null;
	invite_id: string | null;
	invited_by_account_id: string | null;
	username: string;
	invite_auto_follow: number | null;
}

interface EmailVerificationRecord {
	id: string;
	email: string;
	locale: string;
	registration_design: RegistrationDesign;
	registration_state: RegistrationState;
	confirmation_token: string | null;
	email_verification_code_hash: string | null;
	email_verification_sent_at: string | null;
	email_verification_expires_at: string | null;
	email_verification_attempts: number;
}

interface EmailDeliveryLimitRecord {
	window_started_at: string;
	send_count: number;
	last_sent_at: string;
	updated_at: string;
}

interface EmailDeliveryClaim {
	emailHash: string;
	claimedAt: string;
	previous: EmailDeliveryLimitRecord | null;
}

export interface ActivatedRegistration {
	userId: string;
	accountId: string;
	email: string;
	locale: string;
	username: string;
	redirectUri: string;
	design: RegistrationDesign;
	newlyActivated: boolean;
}

type RegistrationActivationExpectation =
	| { kind: 'confirmation_link'; token: string }
	| { kind: 'email_code'; codeHash: string }
	| { kind: 'state'; state: 'awaiting_confirmation' };

const REGISTRATION_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const EMAIL_VERIFICATION_TTL_SECONDS = 60 * 60;
const MAX_EMAIL_VERIFICATION_ATTEMPTS = 8;
const EMAIL_DELIVERY_COOLDOWN_SECONDS = 60;
const EMAIL_DELIVERY_WINDOW_SECONDS = 60 * 60 * 24;
const MAX_EMAIL_DELIVERIES_PER_WINDOW = 10;

function isEnabledSetting(value: string | null): boolean {
	return value === '1' || value === 'true';
}

function invitationIsExpired(expiresAt: string | null): boolean {
	return expiresAt !== null && new Date(expiresAt).getTime() <= Date.now();
}

function toInviter(
	id: string,
	username: string,
	displayName: string | null,
	avatar: string | null,
	avatarStatic: string | null,
): RegistrationInviter {
	return {
		id,
		username,
		acct: username,
		display_name: displayName ?? '',
		avatar: avatar || null,
		avatar_static: avatarStatic || avatar || null,
	};
}

function assertUsableInvitation(record: RegistrationInviteRecord | null): RegistrationInviteRecord {
	if (!record) throw new AppError(404, 'Invitation not found');
	if (record.revoked_at || record.remaining_uses <= 0 || invitationIsExpired(record.expires_at)) {
		throw new AppError(410, 'Invitation is no longer available');
	}
	return record;
}

function inviteRecordToPreview(record: RegistrationInviteRecord): RegistrationInvitePreview {
	return {
		id: record.id,
		inviter: toInviter(
			record.inviter_account_id,
			record.inviter_username,
			record.inviter_display_name,
			record.inviter_avatar_url,
			record.inviter_avatar_static_url,
		),
		uses_remaining: record.remaining_uses,
		expires_at: record.expires_at,
		auto_follow: record.auto_follow !== 0,
	};
}

async function findInvitationByToken(token: string): Promise<RegistrationInviteRecord | null> {
	const tokenHash = await sha256(token);
	return env.DB.prepare(
		`SELECT invitation.*,
		        inviter.username AS inviter_username,
		        inviter.display_name AS inviter_display_name,
		        inviter.avatar_url AS inviter_avatar_url,
		        inviter.avatar_static_url AS inviter_avatar_static_url
		 FROM registration_invites invitation
		 JOIN accounts inviter ON inviter.id = invitation.inviter_account_id
		 JOIN users inviter_user ON inviter_user.account_id = inviter.id
		 WHERE invitation.token_hash = ?1
		   AND inviter.domain IS NULL
		   AND inviter.suspended_at IS NULL
		   AND inviter.memorial = 0
		   AND inviter_user.disabled = 0
		   AND inviter_user.approved = 1
		   AND inviter_user.registration_state = 'active'
		 LIMIT 1`,
	).bind(tokenHash).first<RegistrationInviteRecord>();
}

export function sanitizeRegistrationRedirectUri(value: string | null | undefined): string {
	if (!value || !value.startsWith('/') || value.startsWith('//')) return '/home';
	try {
		const base = new URL('https://registration.invalid');
		const parsed = new URL(value, base);
		if (parsed.origin !== base.origin) return '/home';
		return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/home';
	} catch {
		return '/home';
	}
}

export async function getRegistrationMode(): Promise<RegistrationMode> {
	const configured = (await getSetting('registration_mode')) || env.REGISTRATION_MODE || 'closed';
	switch (configured) {
		case 'open':
		case 'approval':
		case 'referral':
		case 'closed':
			return configured;
		default:
			return 'closed';
	}
}

export async function registrationRequiresEmailVerification(): Promise<boolean> {
	return isEnabledSetting(await getSetting('require_email_verification'));
}

export async function previewRegistrationInvitation(token: string): Promise<RegistrationInvitePreview> {
	if (await getRegistrationMode() === 'closed') {
		throw new AppError(403, 'Registrations are currently closed');
	}
	await restoreExpiredInvitationClaims();
	return inviteRecordToPreview(assertUsableInvitation(await findInvitationByToken(token)));
}

export async function consumeRegistrationInvitation(token: string): Promise<RegistrationInvitePreview> {
	await restoreExpiredInvitationClaims();
	const record = assertUsableInvitation(await findInvitationByToken(token));
	const claimId = await consumeInvitationUse(record.id, record.inviter_account_id);
	if (!claimId) {
		throw new AppError(410, 'Invitation is no longer available');
	}
	return {
		...inviteRecordToPreview(record),
		claim_id: claimId,
		uses_remaining: record.remaining_uses - 1,
	};
}

export async function restoreRegistrationInvitation(
	invitationId: string | null,
	claimId: string | null,
): Promise<void> {
	if (!invitationId || !claimId) return;
	await restoreUnassignedInvitationUse(invitationId, claimId);
}

export async function createRegistrationInvite(
	inviterAccountId: string,
	inviterRole: string,
	input: { uses: number; expiresInDays: number | null; autoFollow: boolean },
): Promise<CreatedRegistrationInvite> {
	return createInvitationLink(inviterAccountId, inviterRole, input);
}

export async function listRegistrationInvites(inviterAccountId: string): Promise<RegistrationInviteSummary[]> {
	return listInvitationLinks(inviterAccountId);
}

export async function revokeRegistrationInvite(inviterAccountId: string, invitationId: string): Promise<void> {
	await revokeInvitationLink(inviterAccountId, invitationId);
}

export async function createRegistrationSession(userId: string): Promise<string> {
	const token = generateToken(64);
	const tokenHash = await sha256(token);
	await env.CACHE.put(`registration_session:${tokenHash}`, userId, {
		expirationTtl: REGISTRATION_SESSION_TTL_SECONDS,
	});
	return token;
}

export async function resolveRegistrationSession(token: string): Promise<string | null> {
	return env.CACHE.get(`registration_session:${await sha256(token)}`);
}

export async function revokeRegistrationSession(token: string): Promise<void> {
	await env.CACHE.delete(`registration_session:${await sha256(token)}`);
}

export async function initializeRegistration(
	userId: string,
	accountId: string,
	input: {
		state: RegistrationState;
		invitation: RegistrationInvitePreview | null;
		redirectUri: string | null | undefined;
		design: RegistrationDesign;
	},
): Promise<void> {
	const invitationClaimId = input.invitation?.claim_id ?? null;
	if (input.invitation && !invitationClaimId) {
		throw new AppError(409, 'Consumed invitation claim is missing');
	}
	const now = new Date().toISOString();
	const pendingExpiresAt = new Date(
		Date.now() + REGISTRATION_SESSION_TTL_SECONDS * 1000,
	).toISOString();
	const claimStatements = input.invitation
		? [env.DB.prepare(
			`UPDATE invitation_use_claims
			 SET assigned_user_id = ?1, expires_at = ?6
			 WHERE id = ?2 AND invitation_id = ?3 AND inviter_account_id = ?4
			   AND assigned_user_id IS NULL AND expires_at > ?5`,
			).bind(
				userId,
				invitationClaimId,
				input.invitation.id,
				input.invitation.inviter.id,
				now,
				pendingExpiresAt,
			)]
		: [];
	const userUpdateIndex = claimStatements.length;
	const assignmentAuditStatements = input.invitation
		? [env.DB.prepare(
			`INSERT INTO invitation_audit_logs
			 (id, actor_account_id, target_account_id, invitation_id, action, credit_delta,
			  contribution_delta, credits_after, contribution_score_after, metadata, created_at)
			 SELECT ?1, NULL, invitation.inviter_account_id, invitation.id, 'invite.assigned',
			        0, 0, balance.available_credits, balance.contribution_score,
			        json_object('invitee_account_id', pending_user.account_id), ?2
			 FROM invitation_use_claims claim
			 JOIN registration_invites invitation ON invitation.id = claim.invitation_id
			 JOIN users pending_user ON pending_user.id = claim.assigned_user_id
			 LEFT JOIN account_invitation_balances balance
			   ON balance.account_id = invitation.inviter_account_id
			 WHERE claim.id = ?3 AND claim.assigned_user_id = ?4
			   AND pending_user.invite_id = invitation.id`,
		).bind(generateUlid(), now, invitationClaimId, userId)]
		: [];
	const results = await env.DB.batch([
		...claimStatements,
		env.DB.prepare(
			`UPDATE users
			 SET approved = 0,
			     confirmed_at = NULL,
			     registration_state = ?1,
			     invite_id = ?2,
			     invited_by_account_id = ?3,
			     registration_redirect_uri = ?4,
			     registration_design = ?5,
			     updated_at = ?6
			 WHERE id = ?7
			   AND (?8 IS NULL OR EXISTS (
			     SELECT 1 FROM invitation_use_claims
			     WHERE id = ?8 AND assigned_user_id = ?7
			   ))`,
		).bind(
			input.state,
			input.invitation?.id ?? null,
			input.invitation?.inviter.id ?? null,
			sanitizeRegistrationRedirectUri(input.redirectUri),
			input.design,
			now,
			userId,
				invitationClaimId,
			),
		...assignmentAuditStatements,
		env.DB.prepare(
			'UPDATE accounts SET discoverable = 0, updated_at = ?1 WHERE id = ?2',
		).bind(now, accountId),
	]);
	if (input.invitation && (results[0]?.meta.changes ?? 0) !== 1) {
		throw new AppError(409, 'Invitation claim was already assigned or expired');
	}
	if ((results[userUpdateIndex]?.meta.changes ?? 0) !== 1) {
		throw new AppError(409, 'Registration could not be linked to its invitation claim');
	}
}

async function getRegistrationStatusRecord(userId: string): Promise<RegistrationStatusRecord | null> {
	return env.DB.prepare(
		`SELECT u.id AS user_id,
		        u.account_id,
		        u.email,
		        u.locale,
		        u.registration_state,
		        u.registration_redirect_uri,
		        u.registration_design,
		        u.confirmation_token,
		        u.email_verification_expires_at,
		        u.invited_by_account_id,
		        account.username,
		        inviter.username AS inviter_username,
		        inviter.display_name AS inviter_display_name,
		        inviter.avatar_url AS inviter_avatar_url,
		        inviter.avatar_static_url AS inviter_avatar_static_url
		 FROM users u
		 JOIN accounts account ON account.id = u.account_id
		 LEFT JOIN accounts inviter ON inviter.id = u.invited_by_account_id
		 WHERE u.id = ?1
		 LIMIT 1`,
	).bind(userId).first<RegistrationStatusRecord>();
}

export async function getRegistrationStatus(userId: string): Promise<RegistrationStatus> {
	let record = await getRegistrationStatusRecord(userId);
	if (!record) throw new AppError(404, 'Registration not found');
	if (record.registration_state === 'email_verification'
		&& (!record.email_verification_expires_at
			|| new Date(record.email_verification_expires_at).getTime() <= Date.now())) {
		const now = new Date().toISOString();
		await env.DB.prepare(
			`UPDATE users
			 SET registration_state = 'awaiting_confirmation',
			     confirmation_token = NULL,
			     email_verification_code_hash = NULL,
			     email_verification_sent_at = NULL,
			     email_verification_expires_at = NULL,
			     email_verification_attempts = 0,
			     updated_at = ?1
			 WHERE id = ?2
			   AND registration_state = 'email_verification'
			   AND (email_verification_expires_at IS NULL OR email_verification_expires_at <= ?1)`,
		).bind(now, userId).run();
		if (record.confirmation_token) {
			await env.CACHE.delete(`email_confirm:${record.confirmation_token}`);
		}
		record = await getRegistrationStatusRecord(userId);
		if (!record) throw new AppError(404, 'Registration not found');
	}
	const invitedBy = record.invited_by_account_id && record.inviter_username
		? toInviter(
			record.invited_by_account_id,
			record.inviter_username,
			record.inviter_display_name,
			record.inviter_avatar_url,
			record.inviter_avatar_static_url,
		)
		: null;
	return {
		state: record.registration_state,
		username: record.username,
		email: record.email,
		invited_by: invitedBy,
		email_verification_required: await registrationRequiresEmailVerification(),
		email_verification_expires_at: record.email_verification_expires_at,
		redirect_uri: sanitizeRegistrationRedirectUri(record.registration_redirect_uri),
	};
}

function generateEmailVerificationCode(): string {
	const value = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
	return String(value % 1_000_000).padStart(6, '0');
}

async function getEmailVerificationRecord(userId: string): Promise<EmailVerificationRecord> {
	const record = await env.DB.prepare(
		`SELECT id, email, locale, registration_design, registration_state, confirmation_token,
		        email_verification_code_hash, email_verification_sent_at,
		        email_verification_expires_at,
		        email_verification_attempts
		 FROM users WHERE id = ?1 LIMIT 1`,
	).bind(userId).first<EmailVerificationRecord>();
	if (!record) throw new AppError(404, 'Registration not found');
	return record;
}

async function claimEmailVerificationDelivery(email: string, now: Date): Promise<EmailDeliveryClaim> {
	const emailHash = await sha256(email.trim().toLowerCase());
	const nowIso = now.toISOString();
	const previous = await env.DB.prepare(
		`SELECT window_started_at, send_count, last_sent_at, updated_at
		 FROM registration_email_delivery_limits WHERE email_hash = ?1`,
	).bind(emailHash).first<EmailDeliveryLimitRecord>();
	const windowCutoff = new Date(
		now.getTime() - EMAIL_DELIVERY_WINDOW_SECONDS * 1000,
	).toISOString();
	const cooldownCutoff = new Date(
		now.getTime() - EMAIL_DELIVERY_COOLDOWN_SECONDS * 1000,
	).toISOString();
	const result = await env.DB.prepare(
		`INSERT INTO registration_email_delivery_limits
		 (email_hash, window_started_at, send_count, last_sent_at, updated_at)
		 VALUES (?1, ?2, 1, ?2, ?2)
		 ON CONFLICT(email_hash) DO UPDATE SET
		   window_started_at = CASE
		     WHEN registration_email_delivery_limits.window_started_at <= ?3 THEN ?2
		     ELSE registration_email_delivery_limits.window_started_at
		   END,
		   send_count = CASE
		     WHEN registration_email_delivery_limits.window_started_at <= ?3 THEN 1
		     ELSE registration_email_delivery_limits.send_count + 1
		   END,
		   last_sent_at = ?2,
		   updated_at = ?2
		 WHERE registration_email_delivery_limits.window_started_at <= ?3
		    OR (
		      registration_email_delivery_limits.send_count < ?5
		      AND registration_email_delivery_limits.last_sent_at <= ?4
		    )`,
	).bind(
		emailHash,
		nowIso,
		windowCutoff,
		cooldownCutoff,
		MAX_EMAIL_DELIVERIES_PER_WINDOW,
	).run();
	if ((result.meta.changes ?? 0) !== 1) {
		throw new AppError(429, 'Please wait before requesting another confirmation email');
	}
	return { emailHash, claimedAt: nowIso, previous };
}

async function restoreEmailVerificationDeliveryClaim(claim: EmailDeliveryClaim): Promise<void> {
	if (!claim.previous) {
		await env.DB.prepare(
			`DELETE FROM registration_email_delivery_limits
			 WHERE email_hash = ?1 AND last_sent_at = ?2`,
		).bind(claim.emailHash, claim.claimedAt).run();
		return;
	}
	await env.DB.prepare(
		`UPDATE registration_email_delivery_limits
		 SET window_started_at = ?1, send_count = ?2, last_sent_at = ?3, updated_at = ?4
		 WHERE email_hash = ?5 AND last_sent_at = ?6`,
	).bind(
		claim.previous.window_started_at,
		claim.previous.send_count,
		claim.previous.last_sent_at,
		claim.previous.updated_at,
		claim.emailHash,
		claim.claimedAt,
	).run();
}

export async function startEmailVerification(userId: string): Promise<RegistrationStatus> {
	const record = await getEmailVerificationRecord(userId);
	if (record.registration_state === 'pending_approval') {
		throw new AppError(409, 'Registration is pending administrator approval');
	}
	if (record.registration_state === 'active') {
		throw new AppError(409, 'Registration is already active');
	}

	const code = generateEmailVerificationCode();
	const codeHash = await sha256(code);
	const linkToken = generateToken(64);
	const now = new Date();
	const expiresAt = new Date(now.getTime() + EMAIL_VERIFICATION_TTL_SECONDS * 1000).toISOString();
	const deliveryClaim = await claimEmailVerificationDelivery(record.email, now);
	const update = await env.DB.prepare(
		`UPDATE users
		 SET registration_state = 'email_verification',
		     confirmation_token = ?1,
		     email_verification_code_hash = ?2,
		     email_verification_sent_at = ?3,
		     email_verification_expires_at = ?4,
		     email_verification_attempts = CASE
		       WHEN registration_state = 'email_verification'
		        AND email_verification_expires_at > ?3
		       THEN email_verification_attempts
		       ELSE 0
		     END,
		     updated_at = ?3
		 WHERE id = ?5
		   AND registration_state = ?6
		   AND COALESCE(confirmation_token, '') = COALESCE(?7, '')
		   AND COALESCE(email_verification_code_hash, '') = COALESCE(?8, '')
		   AND COALESCE(email_verification_expires_at, '') = COALESCE(?9, '')`,
	).bind(
		linkToken,
		codeHash,
		now.toISOString(),
		expiresAt,
		userId,
		record.registration_state,
		record.confirmation_token,
		record.email_verification_code_hash,
		record.email_verification_expires_at,
	).run();
	if ((update.meta.changes ?? 0) !== 1) {
		throw new AppError(409, 'Registration state changed while issuing verification');
	}
	await env.CACHE.put(
		`email_confirm:${linkToken}`,
		JSON.stringify({
			userId,
			email: record.email,
			registration: true,
			locale: record.locale,
			design: record.registration_design,
		}),
		{ expirationTtl: EMAIL_VERIFICATION_TTL_SECONDS },
	);
	const queued = await sendConfirmation(
		record.email,
		linkToken,
		record.locale,
		code,
		record.registration_design,
	);
	if (!queued) {
		await Promise.all([
			env.DB.prepare(
				`UPDATE users
				 SET registration_state = ?1,
				     confirmation_token = ?2,
				     email_verification_code_hash = ?3,
				     email_verification_sent_at = ?4,
				     email_verification_expires_at = ?5,
				     email_verification_attempts = ?6,
				     updated_at = ?7
				 WHERE id = ?8
				   AND registration_state = 'email_verification'
				   AND confirmation_token = ?9
				   AND email_verification_code_hash = ?10`,
			).bind(
				record.registration_state,
				record.confirmation_token,
				record.email_verification_code_hash,
				record.email_verification_sent_at,
				record.email_verification_expires_at,
				record.email_verification_attempts,
				now.toISOString(),
				userId,
				linkToken,
				codeHash,
			).run(),
			env.CACHE.delete(`email_confirm:${linkToken}`),
			restoreEmailVerificationDeliveryClaim(deliveryClaim),
		]);
		throw new AppError(503, 'Unable to queue confirmation email', 'Please try again.');
	}
	if (record.confirmation_token) {
		await env.CACHE.delete(`email_confirm:${record.confirmation_token}`);
	}
	return getRegistrationStatus(userId);
}

async function getActivationRecord(userId: string): Promise<RegistrationActivationRecord> {
	const record = await env.DB.prepare(
		`SELECT u.id AS user_id,
		        u.account_id,
		        u.email,
		        u.locale,
		        u.registration_state,
		        u.registration_redirect_uri,
		        u.registration_design,
		        u.confirmation_token,
		        u.invite_id,
		        u.invited_by_account_id,
		        account.username,
		        invitation.auto_follow AS invite_auto_follow
		 FROM users u
		 JOIN accounts account ON account.id = u.account_id
		 LEFT JOIN registration_invites invitation ON invitation.id = u.invite_id
		 WHERE u.id = ?1 LIMIT 1`,
	).bind(userId).first<RegistrationActivationRecord>();
	if (!record) throw new AppError(404, 'Registration not found');
	return record;
}

function mutualFollowStatements(record: RegistrationActivationRecord, now: string): D1PreparedStatement[] {
	const inviterId = record.invited_by_account_id;
	if (!inviterId || inviterId === record.account_id || record.invite_auto_follow === 0) return [];

	const inviteeToInviterId = generateUlid();
	const inviterToInviteeId = generateUlid();
	const inviteeToInviterUri = `https://${env.INSTANCE_DOMAIN}/activities/${generateUlid()}`;
	const inviterToInviteeUri = `https://${env.INSTANCE_DOMAIN}/activities/${generateUlid()}`;
	return [
		env.DB.prepare(
			`INSERT OR IGNORE INTO follows
			 (id, account_id, target_account_id, uri, show_reblogs, notify, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, 1, 0, ?5, ?5)`,
		).bind(inviteeToInviterId, record.account_id, inviterId, inviteeToInviterUri, now),
		env.DB.prepare(
			`UPDATE accounts SET following_count = following_count + 1
			 WHERE id = ?1 AND EXISTS (SELECT 1 FROM follows WHERE id = ?2)`,
		).bind(record.account_id, inviteeToInviterId),
		env.DB.prepare(
			`UPDATE accounts SET followers_count = followers_count + 1
			 WHERE id = ?1 AND EXISTS (SELECT 1 FROM follows WHERE id = ?2)`,
		).bind(inviterId, inviteeToInviterId),
		env.DB.prepare(
			`INSERT OR IGNORE INTO follows
			 (id, account_id, target_account_id, uri, show_reblogs, notify, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, 1, 0, ?5, ?5)`,
		).bind(inviterToInviteeId, inviterId, record.account_id, inviterToInviteeUri, now),
		env.DB.prepare(
			`UPDATE accounts SET following_count = following_count + 1
			 WHERE id = ?1 AND EXISTS (SELECT 1 FROM follows WHERE id = ?2)`,
		).bind(inviterId, inviterToInviteeId),
		env.DB.prepare(
			`UPDATE accounts SET followers_count = followers_count + 1
			 WHERE id = ?1 AND EXISTS (SELECT 1 FROM follows WHERE id = ?2)`,
		).bind(record.account_id, inviterToInviteeId),
	];
}

export async function activateRegistration(
	userId: string,
	expectation?: RegistrationActivationExpectation,
): Promise<ActivatedRegistration> {
	const record = await getActivationRecord(userId);
	if (record.registration_state === 'pending_approval') {
		throw new AppError(409, 'Registration is pending administrator approval');
	}
	if (record.registration_state !== 'active'
		&& record.registration_state !== 'awaiting_confirmation'
		&& record.registration_state !== 'email_verification') {
		throw new AppError(409, 'Registration cannot be activated');
	}

	const now = new Date().toISOString();
	const activation = expectation?.kind === 'confirmation_link'
		? env.DB.prepare(
			`UPDATE users
			 SET approved = 1,
			     confirmed_at = ?1,
			     confirmation_token = NULL,
			     registration_state = 'active',
			     email_verification_code_hash = NULL,
			     email_verification_sent_at = NULL,
			     email_verification_expires_at = NULL,
			     email_verification_attempts = 0,
			     updated_at = ?1
			 WHERE id = ?2
			   AND registration_state = 'email_verification'
			   AND confirmation_token = ?3`,
		).bind(now, userId, expectation.token)
		: expectation?.kind === 'email_code'
			? env.DB.prepare(
				`UPDATE users
				 SET approved = 1,
				     confirmed_at = ?1,
				     confirmation_token = NULL,
				     registration_state = 'active',
				     email_verification_code_hash = NULL,
				     email_verification_sent_at = NULL,
				     email_verification_expires_at = NULL,
				     email_verification_attempts = 0,
				     updated_at = ?1
				 WHERE id = ?2
				   AND registration_state = 'email_verification'
				   AND email_verification_code_hash = ?3`,
			).bind(now, userId, expectation.codeHash)
			: expectation?.kind === 'state'
				? env.DB.prepare(
					`UPDATE users
					 SET approved = 1,
					     confirmed_at = ?1,
					     confirmation_token = NULL,
					     registration_state = 'active',
					     email_verification_code_hash = NULL,
					     email_verification_sent_at = NULL,
					     email_verification_expires_at = NULL,
					     email_verification_attempts = 0,
					     updated_at = ?1
					 WHERE id = ?2 AND registration_state = ?3`,
				).bind(now, userId, expectation.state)
				: env.DB.prepare(
				`UPDATE users
			 SET approved = 1,
			     confirmed_at = ?1,
			     confirmation_token = NULL,
			     registration_state = 'active',
			     email_verification_code_hash = NULL,
			     email_verification_sent_at = NULL,
			     email_verification_expires_at = NULL,
			     email_verification_attempts = 0,
			     updated_at = ?1
			 WHERE id = ?2 AND registration_state != 'active'`,
				).bind(now, userId);
	const results = await env.DB.batch([
		activation,
		env.DB.prepare(
			`UPDATE accounts SET discoverable = 1, updated_at = ?1
			 WHERE id = ?2 AND EXISTS (
			   SELECT 1 FROM users WHERE id = ?3 AND registration_state = 'active'
			 )`,
			).bind(now, record.account_id, userId),
		env.DB.prepare(
			`INSERT INTO invitation_audit_logs
			 (id, actor_account_id, target_account_id, invitation_id, action, credit_delta,
			  contribution_delta, credits_after, contribution_score_after, metadata, created_at)
			 SELECT ?1, NULL, invitation.inviter_account_id, invitation.id, 'invite.completed',
			        0, 0, balance.available_credits, balance.contribution_score,
			        json_object('invitee_account_id', active_user.account_id), ?2
			 FROM invitation_use_claims claim
			 JOIN registration_invites invitation ON invitation.id = claim.invitation_id
			 JOIN users active_user ON active_user.id = claim.assigned_user_id
			 LEFT JOIN account_invitation_balances balance
			   ON balance.account_id = invitation.inviter_account_id
			 WHERE claim.assigned_user_id = ?3 AND active_user.registration_state = 'active'`,
		).bind(generateUlid(), now, userId),
		env.DB.prepare(
			`DELETE FROM invitation_use_claims
			 WHERE assigned_user_id = ?1
			   AND EXISTS (
			     SELECT 1 FROM users WHERE id = ?1 AND registration_state = 'active'
			   )`,
		).bind(userId),
		...mutualFollowStatements(record, now),
	]);
	const newlyActivated = (results[0]?.meta.changes ?? 0) === 1;
	const invitationClaimFinalized = (results[3]?.meta.changes ?? 0) === 1;
	if (expectation && !newlyActivated) {
		throw new AppError(410, 'Registration verification was already completed or changed');
	}
	if (record.confirmation_token) await env.CACHE.delete(`email_confirm:${record.confirmation_token}`);
	if ((newlyActivated || invitationClaimFinalized) && record.invited_by_account_id) {
		await reconcileContributionAwards(record.invited_by_account_id).catch(() => undefined);
	}
	if (newlyActivated) {
		await sendWelcome(record.email, record.username, record.locale).catch(() => false);
	}
	return {
		userId: record.user_id,
		accountId: record.account_id,
		email: record.email,
		locale: record.locale,
		username: record.username,
		redirectUri: sanitizeRegistrationRedirectUri(record.registration_redirect_uri),
		design: record.registration_design,
		newlyActivated,
	};
}

export async function continueRegistration(userId: string): Promise<RegistrationStatus | ActivatedRegistration> {
	const status = await getRegistrationStatus(userId);
	if (status.state === 'pending_approval') {
		throw new AppError(409, 'Registration is pending administrator approval');
	}
	if (status.state === 'active') {
		throw new AppError(409, 'Registration is already active');
	}
	if (await registrationRequiresEmailVerification()) {
		return startEmailVerification(userId);
	}
	return activateRegistration(userId, { kind: 'state', state: 'awaiting_confirmation' });
}

export async function verifyRegistrationCode(userId: string, code: string): Promise<ActivatedRegistration> {
	const record = await getEmailVerificationRecord(userId);
	if (record.registration_state !== 'email_verification') {
		throw new AppError(409, 'Email verification is not pending');
	}
	if (!record.email_verification_expires_at
		|| new Date(record.email_verification_expires_at).getTime() <= Date.now()) {
		throw new AppError(410, 'Email verification code has expired');
	}
	if (record.email_verification_attempts >= MAX_EMAIL_VERIFICATION_ATTEMPTS) {
		throw new AppError(429, 'Too many verification attempts');
	}

	// Claim one of the bounded verification attempts atomically before checking
	// the submitted value. Parallel guesses can therefore consume at most the
	// configured number of attempts in total, rather than each observing the
	// same stale counter.
	const claimed = await env.DB.prepare(
		`UPDATE users
		 SET email_verification_attempts = email_verification_attempts + 1
		 WHERE id = ?1
		   AND registration_state = 'email_verification'
		   AND email_verification_code_hash = ?2
		   AND email_verification_expires_at = ?3
		   AND email_verification_expires_at > ?4
		   AND email_verification_attempts < ?5`,
	).bind(
		userId,
		record.email_verification_code_hash,
		record.email_verification_expires_at,
		new Date().toISOString(),
		MAX_EMAIL_VERIFICATION_ATTEMPTS,
	).run();
	if ((claimed.meta.changes ?? 0) !== 1) {
		const current = await getEmailVerificationRecord(userId);
		if (current.registration_state !== 'email_verification') {
			throw new AppError(409, 'Email verification is not pending');
		}
		if (!current.email_verification_expires_at
			|| new Date(current.email_verification_expires_at).getTime() <= Date.now()) {
			throw new AppError(410, 'Email verification code has expired');
		}
		if (current.email_verification_attempts >= MAX_EMAIL_VERIFICATION_ATTEMPTS) {
			throw new AppError(429, 'Too many verification attempts');
		}
		throw new AppError(409, 'Email verification challenge changed');
	}

	if (!/^\d{6}$/.test(code) || await sha256(code) !== record.email_verification_code_hash) {
		throw new AppError(422, 'Invalid email verification code');
	}
	return activateRegistration(userId, {
		kind: 'email_code',
		codeHash: record.email_verification_code_hash ?? '',
	});
}

export async function validateRegistrationLink(userId: string, token: string): Promise<void> {
	const record = await getEmailVerificationRecord(userId);
	if (record.registration_state !== 'email_verification'
		|| record.confirmation_token !== token
		|| !record.email_verification_expires_at
		|| new Date(record.email_verification_expires_at).getTime() <= Date.now()) {
		throw new AppError(410, 'Email verification link has expired');
	}
}

export async function confirmRegistrationLink(userId: string, token: string): Promise<ActivatedRegistration> {
	await validateRegistrationLink(userId, token);
	return activateRegistration(userId, { kind: 'confirmation_link', token });
}

export async function approvePendingRegistration(accountId: string): Promise<void> {
	const now = new Date().toISOString();
	const result = await env.DB.prepare(
		`UPDATE users
		 SET registration_state = 'awaiting_confirmation', updated_at = ?1
		 WHERE account_id = ?2 AND registration_state = 'pending_approval' AND approved = 0`,
	).bind(now, accountId).run();
	if ((result.meta.changes ?? 0) !== 1) {
		throw new AppError(403, 'This account is not pending approval');
	}
}

export async function deletePendingRegistration(
	userId: string,
	expectedState?: 'pending_approval',
	reason: 'cancelled' | 'expired' | 'rejected' = 'cancelled',
	options: { startCancellationCooldown?: boolean } = {},
): Promise<void> {
	const record = await env.DB.prepare(
		`SELECT pending_user.id, pending_user.account_id, pending_user.invite_id,
		        pending_user.confirmation_token, pending_user.registration_state,
		        pending_user.approved, pending_user.email,
		        claim.id AS invitation_claim_id
		 FROM users pending_user
		 LEFT JOIN invitation_use_claims claim ON claim.assigned_user_id = pending_user.id
		 WHERE pending_user.id = ?1 LIMIT 1`,
	).bind(userId).first<{
		id: string;
		account_id: string;
		invite_id: string | null;
		confirmation_token: string | null;
		registration_state: RegistrationState;
		approved: number;
		email: string;
		invitation_claim_id: string | null;
	}>();
	if (!record) throw new AppError(404, 'Registration not found');
	if (expectedState && record.registration_state !== expectedState) {
		throw new AppError(409, 'Registration state changed before deletion');
	}
	if (record.registration_state === 'active' && record.approved !== 0) {
		throw new AppError(403, 'Active accounts cannot be cancelled through registration');
	}

	const statements: D1PreparedStatement[] = [];
	if (record.invite_id && record.invitation_claim_id) {
		statements.push(...await invitationCancellationRestoreStatements(
			record.invite_id,
			record.invitation_claim_id,
				record.id,
				expectedState,
				reason,
			));
	}
	const stillPending = expectedState === 'pending_approval'
		? "registration_state = 'pending_approval' AND approved = 0"
		: "registration_state != 'active' OR approved = 0";
	if (reason === 'cancelled' && options.startCancellationCooldown === true) {
		const now = new Date();
		const cancelledAt = now.toISOString();
		const expiresAt = new Date(
			now.getTime() + REGISTRATION_CANCELLATION_COOLDOWN_MS,
		).toISOString();
		statements.push(env.DB.prepare(
			`INSERT INTO registration_cancellation_cooldowns
			 (email_hash, cancelled_at, expires_at, updated_at)
			 SELECT ?1, ?2, ?3, ?2
			 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?4 AND (${stillPending}))
			 ON CONFLICT(email_hash) DO UPDATE SET
			   cancelled_at = excluded.cancelled_at,
			   expires_at = excluded.expires_at,
			   updated_at = excluded.updated_at`,
		).bind(await sha256(record.email.trim().toLowerCase()), cancelledAt, expiresAt, record.id));
	}
	statements.push(
		env.DB.prepare(
			`DELETE FROM oauth_access_tokens
			 WHERE user_id = ?1
			   AND EXISTS (SELECT 1 FROM users WHERE id = ?1 AND (${stillPending}))`,
		).bind(record.id),
		env.DB.prepare(
			`DELETE FROM webauthn_credentials
			 WHERE user_id = ?1
			   AND EXISTS (SELECT 1 FROM users WHERE id = ?1 AND (${stillPending}))`,
		).bind(record.id),
		env.DB.prepare(
			`DELETE FROM user_preferences
			 WHERE user_id = ?1
			   AND EXISTS (SELECT 1 FROM users WHERE id = ?1 AND (${stillPending}))`,
		).bind(record.id),
		env.DB.prepare(
			`DELETE FROM actor_keys
			 WHERE account_id = ?1
			   AND EXISTS (SELECT 1 FROM users WHERE id = ?2 AND (${stillPending}))`,
		).bind(record.account_id, record.id),
	);
	const deleteUserIndex = statements.length;
	statements.push(
		env.DB.prepare(
			`DELETE FROM users WHERE id = ?1 AND (${stillPending})`,
		).bind(record.id),
		env.DB.prepare(
			`DELETE FROM accounts
			 WHERE id = ?1
			   AND NOT EXISTS (SELECT 1 FROM users WHERE account_id = ?1)`,
		).bind(record.account_id),
	);
	const results = await env.DB.batch(statements);
	if ((results[deleteUserIndex]?.meta.changes ?? 0) !== 1) {
		throw new AppError(409, 'Registration became active before it could be cancelled');
	}
	if (record.confirmation_token) await env.CACHE.delete(`email_confirm:${record.confirmation_token}`);
	if ((results[deleteUserIndex + 1]?.meta.changes ?? 0) === 1) {
		await env.MEDIA_BUCKET.delete([
			`avatars/${record.account_id}_default.svg`,
			`headers/${record.account_id}_default.svg`,
		]).catch((error: unknown) => {
			console.error('Unable to delete default registration media', {
				accountId: record.account_id,
				error,
			});
		});
	}
}

export async function cleanupExpiredInvitedRegistrations(
	inviterAccountId: string,
	limit = 25,
): Promise<number> {
	const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 25;
	const restoredUnassignedClaims = await restoreExpiredInvitationClaims(safeLimit);
	const { results } = await env.DB.prepare(
		`SELECT pending_user.id
		 FROM invitation_use_claims claim
		 JOIN users pending_user ON pending_user.id = claim.assigned_user_id
		 WHERE claim.inviter_account_id = ?1 AND claim.expires_at <= ?2
		   AND (pending_user.registration_state != 'active' OR pending_user.approved = 0)
		 ORDER BY claim.expires_at, claim.id LIMIT ?3`,
	).bind(inviterAccountId, new Date().toISOString(), safeLimit).all<{ id: string }>();
	let cleaned = 0;
	for (const row of results ?? []) {
		try {
			await deletePendingRegistration(row.id, undefined, 'expired');
			cleaned += 1;
		} catch (error: unknown) {
			console.error('Unable to clean up expired invited registration', {
				inviterAccountId,
				userId: row.id,
				error,
			});
		}
	}
	return cleaned + restoredUnassignedClaims;
}
