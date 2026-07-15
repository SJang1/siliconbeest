import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { AppVariables } from '../../../../../types';
import { AppError } from '../../../../../middleware/errorHandler';
import { adjustContributionScore } from '../../../../../services/contribution';
import { hasStaffCapability } from '../../../../../../../../packages/shared/permissions';

type HonoEnv = { Variables: AppVariables };

type ResolveReportBody = {
	contribution_adjustment?: {
		account_id?: string;
		points: number;
		reason?: string;
	};
};

type ReportResolveRow = {
	id: string;
	account_id: string;
	target_account_id: string;
	assigned_account_id: string | null;
	action_taken_at: string | null;
	action_taken_by_account_id: string | null;
	category: string | null;
	comment: string | null;
	forwarded: number;
	created_at: string;
	updated_at: string;
};

const app = new Hono<HonoEnv>();

/**
 * POST /api/v1/admin/reports/:id/resolve — mark a report as resolved.
 */
app.post('/:id/resolve', async (c) => {
	const id = c.req.param('id');
	const currentUser = c.get('currentUser')!;
	const now = new Date().toISOString();
	let body: ResolveReportBody = {};
	if ((c.req.header('content-type') ?? '').includes('application/json')) {
		try {
			body = await c.req.json<ResolveReportBody>();
		} catch {
			throw new AppError(422, 'Validation failed', 'Unable to parse request body');
		}
	}

	const row = await env.DB.prepare('SELECT * FROM reports WHERE id = ?1')
		.bind(id)
		.first<ReportResolveRow>();
	if (!row) throw new AppError(404, 'Record not found');

	const adjustment = body.contribution_adjustment;
	if (adjustment !== undefined) {
		if (!hasStaffCapability(currentUser.role, 'roles:manage')) {
			throw new AppError(403, 'Only administrators can adjust contribution scores');
		}
		if (!adjustment
			|| !Number.isSafeInteger(adjustment.points)
			|| Math.abs(adjustment.points) > 1_000_000_000) {
			throw new AppError(422, 'Validation failed', 'contribution_adjustment.points must be a safe integer');
		}
		if (adjustment.account_id !== undefined && typeof adjustment.account_id !== 'string') {
			throw new AppError(422, 'Validation failed', 'contribution_adjustment.account_id must be a string');
		}
		if (adjustment.account_id !== undefined && adjustment.account_id !== row.target_account_id) {
			throw new AppError(
				422,
				'Validation failed',
				'contribution_adjustment.account_id must match the reported account',
			);
		}
		if (adjustment.reason !== undefined
			&& (typeof adjustment.reason !== 'string' || adjustment.reason.length > 500)) {
			throw new AppError(422, 'Validation failed', 'contribution_adjustment.reason must be at most 500 characters');
		}
	}

	const resolved = await env.DB.prepare(
		`UPDATE reports
		 SET action_taken = 1, action_taken_at = ?1, action_taken_by_account_id = ?2, updated_at = ?1
		 WHERE id = ?3 AND action_taken_at IS NULL`,
	)
		.bind(now, currentUser.account_id, id)
		.run();
	const newlyResolved = (resolved.meta.changes ?? 0) === 1;
	let contributionAdjustmentApplied: boolean | null = null;
	let contributionAdjustmentError: string | null = null;

	if (adjustment) {
		if (!newlyResolved) {
			contributionAdjustmentApplied = false;
			contributionAdjustmentError = 'The report was already resolved';
		} else if (adjustment.points === 0) {
			contributionAdjustmentApplied = true;
		} else {
			try {
				await adjustContributionScore({
					targetAccountId: row.target_account_id,
					actorAccountId: currentUser.account_id,
					delta: adjustment.points,
					reason: adjustment.reason,
					source: 'report_resolution',
					referenceId: id,
				});
				contributionAdjustmentApplied = true;
			} catch (error) {
				console.error('Unable to apply report contribution adjustment', { reportId: id, error });
				const rolledBack = await env.DB.prepare(
					`UPDATE reports
					 SET action_taken = 0,
					     action_taken_at = NULL,
					     action_taken_by_account_id = NULL,
					     updated_at = ?1
					 WHERE id = ?2
					   AND action_taken = 1
					   AND action_taken_at = ?3
					   AND action_taken_by_account_id = ?4`,
				).bind(row.updated_at, id, now, currentUser.account_id).run();
				if ((rolledBack.meta.changes ?? 0) !== 1) {
					throw new AppError(
						500,
						'The contribution adjustment failed and report state could not be restored',
					);
				}
				throw new AppError(
					503,
					'The contribution adjustment could not be applied',
					'The report remains unresolved and can be retried',
				);
			}
		}
	}
	const actionTakenAt = newlyResolved ? now : (row.action_taken_at ?? now);
	const actionTakenByAccountId = newlyResolved
		? currentUser.account_id
		: (row.action_taken_by_account_id ?? currentUser.account_id);

	return c.json({
		id: row.id,
		action_taken: true,
		action_taken_at: actionTakenAt,
		category: row.category || 'other',
		comment: row.comment || '',
		forwarded: !!(row.forwarded),
		created_at: row.created_at,
		updated_at: actionTakenAt,
		account: { id: row.account_id },
		target_account: { id: row.target_account_id },
		assigned_account: row.assigned_account_id ? { id: row.assigned_account_id } : null,
		action_taken_by_account: { id: actionTakenByAccountId },
		contribution_adjustment_applied: contributionAdjustmentApplied,
		contribution_adjustment_error: contributionAdjustmentError,
		statuses: [],
		rules: [],
	});
});

export default app;
