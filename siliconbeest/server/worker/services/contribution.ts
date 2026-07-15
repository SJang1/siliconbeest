import { env } from 'cloudflare:workers';
import { generateUlid } from '../utils/ulid';
import { AppError } from '../middleware/errorHandler';

export const CONTRIBUTION_EVENTS = [
	'status_create',
	'reply_create',
	'status_delete',
	'status_reblog',
	'status_unreblog',
	'status_favourite',
	'status_unfavourite',
	'account_follow',
	'account_unfollow',
	'poll_vote',
	'media_upload',
	'status_bookmark',
	'status_unbookmark',
	'profile_update',
	'report_submit',
	'list_create',
	'list_delete',
	'generic_mutation',
] as const;

export type ContributionEvent = typeof CONTRIBUTION_EVENTS[number];

export type ContributionBalance = {
	accountId: string;
	availableCredits: number;
	contributionScore: number;
	contributionAwardLevel: number;
};

export type ContributionUpdateResult = ContributionBalance & {
	processed: true;
	contributionDelta: number;
	creditsAwarded: number;
};

export type ContributionSkippedResult = {
	processed: false;
	reason: 'disabled' | 'zero_points';
};

export type ContributionResult = ContributionUpdateResult | ContributionSkippedResult;

type ContributionBalanceRow = {
	account_id: string;
	available_credits: number;
	contribution_score: number;
	contribution_award_level: number;
};

type ContributionEventSettings = {
	enabled: boolean;
	points: number;
};

type AuditMetadataValue = string | number | boolean | null;
type AuditMetadata = Readonly<Record<string, AuditMetadataValue>>;

type ApplyContributionOptions = {
	actorAccountId: string | null;
	metadata: AuditMetadata;
};

export type ContributionEventContext = {
	requestId?: string;
	method?: string;
	path?: string;
};

export type AdminContributionAdjustment = {
	targetAccountId: string;
	actorAccountId: string;
	delta: number;
	reason?: string;
	source?: string;
	referenceId?: string;
};

const DEFAULT_THRESHOLD = 100;
const DEFAULT_CREDIT_CAP = 999;
const MAX_ABSOLUTE_SETTING = 1_000_000_000;
const MAX_UPDATE_ATTEMPTS = 5;

const LIVE_CREDIT_CAP_SQL = `COALESCE((
	SELECT CAST(value AS INTEGER) FROM settings
	WHERE key = 'invite_credit_max_per_account' LIMIT 1
), ${DEFAULT_CREDIT_CAP})`;

const LIVE_CONTRIBUTION_THRESHOLD_SQL = `MAX(1, COALESCE((
	SELECT CAST(value AS INTEGER) FROM settings
	WHERE key = 'invite_contribution_threshold' LIMIT 1
), ${DEFAULT_THRESHOLD}))`;

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
		SELECT COUNT(*) FROM invitation_use_claims claim
		WHERE claim.inviter_account_id = ${accountExpression}
	), 0)`;
}

function liveContributionAwardSql(
	scoreExpression: string,
	accountExpression: string,
): string {
	return `CASE WHEN ${LIVE_CONTRIBUTION_ENABLED_SQL} THEN MIN(
		MAX(0, CAST(MAX(${scoreExpression}, 0) / ${LIVE_CONTRIBUTION_THRESHOLD_SQL} AS INTEGER)
		  - contribution_award_level),
		MAX(0, ${LIVE_CREDIT_CAP_SQL} - available_credits
		  - ${activeReservedCreditsSql(accountExpression)}
		  - ${pendingRefundCreditsSql(accountExpression)})
	) ELSE 0 END`;
}

function parseIntegerSetting(
	value: string | undefined,
	fallback: number,
	minimum: number,
): number {
	if (value === undefined || !/^-?\d+$/.test(value)) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > MAX_ABSOLUTE_SETTING) {
		return fallback;
	}
	return parsed;
}

function assertSafeDelta(delta: number): void {
	if (!Number.isSafeInteger(delta) || Math.abs(delta) > MAX_ABSOLUTE_SETTING) {
		throw new RangeError('Contribution delta must be a safe integer between -1000000000 and 1000000000');
	}
}

export function contributionSettingKey(event: ContributionEvent): `invite_contribution_points_${ContributionEvent}` {
	return `invite_contribution_points_${event}`;
}

async function getContributionSettings(event: ContributionEvent): Promise<ContributionEventSettings> {
	const eventKey = contributionSettingKey(event);
	const keys = [
		'invite_contribution_enabled',
		eventKey,
	];
	const placeholders = keys.map(() => '?').join(', ');
	const { results } = await env.DB.prepare(
		`SELECT key, value FROM settings WHERE key IN (${placeholders})`,
	).bind(...keys).all<{ key: string; value: string }>();
	const values = new Map((results ?? []).map((row) => [row.key, row.value]));

	return {
		enabled: values.get('invite_contribution_enabled') === '1',
		points: parseIntegerSetting(values.get(eventKey), 0, -MAX_ABSOLUTE_SETTING),
	};
}

async function ensureContributionBalance(accountId: string): Promise<void> {
	const now = new Date().toISOString();
	await env.DB.prepare(
		`INSERT OR IGNORE INTO account_invitation_balances
		 (account_id, available_credits, contribution_score, contribution_award_level, created_at, updated_at)
		 SELECT accounts.id, 0, 0, 0, ?2, ?2
		 FROM accounts JOIN users ON users.account_id = accounts.id
		 WHERE accounts.id = ?1 AND accounts.domain IS NULL`,
	).bind(accountId, now).run();
}

async function getContributionBalanceRow(accountId: string): Promise<ContributionBalanceRow> {
	const row = await env.DB.prepare(
		`SELECT account_id, available_credits, contribution_score, contribution_award_level
		 FROM account_invitation_balances WHERE account_id = ?1`,
	).bind(accountId).first<ContributionBalanceRow>();
	if (!row) throw new AppError(404, 'Local account not found');
	return row;
}

function toContributionBalance(row: ContributionBalanceRow): ContributionBalance {
	return {
		accountId: row.account_id,
		availableCredits: row.available_credits,
		contributionScore: row.contribution_score,
		contributionAwardLevel: row.contribution_award_level,
	};
}

async function applyContributionDelta(
	accountId: string,
	delta: number,
	options: ApplyContributionOptions,
): Promise<ContributionUpdateResult> {
	assertSafeDelta(delta);
	await ensureContributionBalance(accountId);

	for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
		const current = await getContributionBalanceRow(accountId);
		const nextScore = current.contribution_score + delta;
		if (!Number.isSafeInteger(nextScore)) {
			throw new RangeError('Contribution score exceeds the safe integer range');
		}

		const now = new Date().toISOString();
		const operationId = generateUlid();
		const liveAwardSql = liveContributionAwardSql(
			'?1',
			'account_invitation_balances.account_id',
		);

		const statements = [
			env.DB.prepare(
				`UPDATE account_invitation_balances
				 SET last_credit_delta = ${liveAwardSql},
				     available_credits = available_credits + ${liveAwardSql},
				     contribution_score = ?1,
				     contribution_award_level = contribution_award_level + ${liveAwardSql},
				     last_operation_id = ?2,
				     updated_at = ?3
				 WHERE account_id = ?4
				   AND available_credits = ?5
				   AND contribution_score = ?6
				   AND contribution_award_level = ?7`,
			).bind(
				nextScore,
				operationId,
				now,
				accountId,
				current.available_credits,
				current.contribution_score,
				current.contribution_award_level,
			),
		];

		if (delta !== 0) {
			statements.push(env.DB.prepare(
				`INSERT INTO invitation_audit_logs
				 (id, actor_account_id, target_account_id, invitation_id, action,
				  credit_delta, contribution_delta, credits_after, contribution_score_after,
				  metadata, created_at)
				 SELECT ?1, ?2, balance.account_id, NULL, 'contribution.adjusted',
				        0, ?3, balance.available_credits, balance.contribution_score, ?4, ?5
				 FROM account_invitation_balances balance
				 WHERE balance.account_id = ?6 AND balance.last_operation_id = ?7`,
			).bind(
				generateUlid(),
				options.actorAccountId,
				delta,
				JSON.stringify(options.metadata),
				now,
				accountId,
				operationId,
			));
		}

		statements.push(env.DB.prepare(
			`INSERT INTO invitation_audit_logs
			 (id, actor_account_id, target_account_id, invitation_id, action,
			  credit_delta, contribution_delta, credits_after, contribution_score_after,
			  metadata, created_at)
			 SELECT ?1, NULL, balance.account_id, NULL, 'contribution.tier_awarded',
			        balance.last_credit_delta, 0, balance.available_credits,
			        balance.contribution_score,
			        json_object(
			          'threshold', ${LIVE_CONTRIBUTION_THRESHOLD_SQL},
			          'from_award_level', balance.contribution_award_level - balance.last_credit_delta,
			          'to_award_level', balance.contribution_award_level
			        ), ?2
			 FROM account_invitation_balances balance
			 WHERE balance.account_id = ?3 AND balance.last_operation_id = ?4
			   AND balance.last_credit_delta > 0`,
		).bind(generateUlid(), now, accountId, operationId));

		const results = await env.DB.batch(statements);
		if ((results[0]?.meta.changes ?? 0) !== 1) continue;
		const updated = await getContributionBalanceRow(accountId);
		const creditsAwarded = updated.available_credits - current.available_credits;

		return {
			processed: true,
			...toContributionBalance(updated),
			contributionDelta: delta,
			creditsAwarded,
		};
	}

	throw new Error('Contribution balance was modified concurrently; retry the activity');
}

export async function recordContributionEvent(
	accountId: string,
	event: ContributionEvent,
	context: ContributionEventContext = {},
): Promise<ContributionResult> {
	const settings = await getContributionSettings(event);
	if (!settings.enabled) return { processed: false, reason: 'disabled' };
	if (settings.points === 0) return { processed: false, reason: 'zero_points' };

	return applyContributionDelta(accountId, settings.points, {
		actorAccountId: null,
		metadata: {
			event,
			request_id: context.requestId ?? null,
			method: context.method ?? null,
			path: context.path ?? null,
		},
	});
}

export async function reconcileContributionAwards(accountId: string): Promise<ContributionUpdateResult> {
	return applyContributionDelta(accountId, 0, {
		actorAccountId: null,
		metadata: { source: 'balance_reconciliation' },
	});
}

export async function adjustContributionScore(
	adjustment: AdminContributionAdjustment,
): Promise<ContributionUpdateResult> {
	assertSafeDelta(adjustment.delta);
	return applyContributionDelta(adjustment.targetAccountId, adjustment.delta, {
		actorAccountId: adjustment.actorAccountId,
		metadata: {
			source: adjustment.source ?? 'admin_adjustment',
			reason: adjustment.reason ?? null,
			reference_id: adjustment.referenceId ?? null,
		},
	});
}
