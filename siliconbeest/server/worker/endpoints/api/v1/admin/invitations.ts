import { Hono } from 'hono';
import type { AppVariables } from '../../../../types';
import { AppError } from '../../../../middleware/errorHandler';
import { adminOnlyRequired, authRequired } from '../../../../middleware/auth';
import { requireScopeForMethod } from '../../../../middleware/scopeCheck';
import {
	addInvitationCredits,
	distributeInvitationCredits,
	getInvitationCreditStatus,
	listInvitationAuditLogs,
	listInvitationBalances,
	resetAllInvitationCredits,
	resetInvitationCredits,
	setInvitationCredits,
} from '../../../../services/invitationCredits';
import { adjustContributionScore } from '../../../../services/contribution';

const app = new Hono<{ Variables: AppVariables }>();

app.use('*', authRequired, adminOnlyRequired);
app.use('*', requireScopeForMethod('admin:read', 'admin:write'));

function integerQuery(value: string | undefined, fallback: number): number {
	if (value === undefined || !/^\d+$/.test(value)) return fallback;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : fallback;
}

app.get('/balances', async (c) => {
	return c.json(await listInvitationBalances(
		integerQuery(c.req.query('page'), 1),
		integerQuery(c.req.query('per_page'), 50),
		c.req.query('q') ?? null,
	));
});

app.patch('/balances/:accountId', async (c) => {
	const body = await c.req.json<{ credits?: number }>().catch((): { credits?: number } => ({}));
	if (body.credits === undefined) throw new AppError(422, 'credits is required');
	const actor = c.get('currentAccount')!;
	return c.json(await setInvitationCredits(actor.id, c.req.param('accountId'), body.credits));
});

app.post('/balances/:accountId/add', async (c) => {
	const body = await c.req.json<{ amount?: number }>().catch((): { amount?: number } => ({}));
	if (body.amount === undefined) throw new AppError(422, 'amount is required');
	const actor = c.get('currentAccount')!;
	return c.json(await addInvitationCredits(actor.id, c.req.param('accountId'), body.amount));
});

app.post('/distribute', async (c) => {
	const body = await c.req.json<{
		account_ids?: string[];
		amount?: number;
	}>().catch((): { account_ids?: string[]; amount?: number } => ({}));
	if (body.account_ids !== undefined && (
		!Array.isArray(body.account_ids)
		|| body.account_ids.some((id) => typeof id !== 'string' || id.length === 0)
	)) {
		throw new AppError(422, 'account_ids must be an array of account IDs');
	}
	const actor = c.get('currentAccount')!;
	return c.json(await distributeInvitationCredits(
		actor.id,
		body.account_ids ?? null,
		body.amount ?? 1,
	));
});

app.post('/reset', async (c) => {
	const body = await c.req.json<{ confirmation?: string }>()
		.catch((): { confirmation?: string } => ({}));
	const actor = c.get('currentAccount')!;
	return c.json(await resetAllInvitationCredits(actor.id, body.confirmation ?? ''));
});

app.get('/audit', async (c) => {
	return c.json(await listInvitationAuditLogs(
		integerQuery(c.req.query('page'), 1),
		integerQuery(c.req.query('per_page'), 50),
		{
			action: c.req.query('action') ?? null,
			accountId: c.req.query('account_id') ?? null,
		},
	));
});

export default app;

export const invitationCreditsAdminApi = new Hono<{ Variables: AppVariables }>();

invitationCreditsAdminApi.use('*', authRequired, adminOnlyRequired);
invitationCreditsAdminApi.use('*', requireScopeForMethod('admin:read', 'admin:write'));

invitationCreditsAdminApi.get('/', async (c) => {
	const limit = Math.min(integerQuery(c.req.query('limit'), 25), 100);
	const offset = integerQuery(c.req.query('offset'), 0);
	const page = Math.floor(offset / Math.max(1, limit)) + 1;
	return c.json(await listInvitationBalances(
		page,
		limit,
		c.req.query('search') ?? null,
		offset,
	));
});

invitationCreditsAdminApi.post('/distribute', async (c) => {
	const body = await c.req.json<{ account_ids?: string[]; amount?: number }>()
		.catch((): { account_ids?: string[]; amount?: number } => ({}));
	if (body.account_ids !== undefined && (
		!Array.isArray(body.account_ids)
		|| body.account_ids.some((id) => typeof id !== 'string' || id.length === 0)
	)) {
		throw new AppError(422, 'account_ids must be an array of account IDs');
	}
	const actor = c.get('currentAccount')!;
	const result = await distributeInvitationCredits(
		actor.id,
		body.account_ids ?? null,
		body.amount ?? 1,
	);
	return c.json({ updated: result.targeted_accounts });
});

invitationCreditsAdminApi.post('/reset', async (c) => {
	const body = await c.req.json<{ account_ids?: string[]; confirmation?: string }>()
		.catch((): { account_ids?: string[]; confirmation?: string } => ({}));
	if (body.confirmation !== 'RESET') throw new AppError(422, 'Explicit reset confirmation is required');
	if (body.account_ids !== undefined && (
		!Array.isArray(body.account_ids)
		|| body.account_ids.some((id) => typeof id !== 'string' || id.length === 0)
	)) {
		throw new AppError(422, 'account_ids must be an array of account IDs');
	}
	const actor = c.get('currentAccount')!;
	const result = await resetInvitationCredits(actor.id, body.account_ids ?? null);
	return c.json({ updated: result.reset_accounts });
});

invitationCreditsAdminApi.post('/:accountId', async (c) => {
	const body = await c.req.json<{
		operation?: 'set' | 'add' | 'contribution';
		amount?: number;
		reason?: string;
	}>().catch((): {
		operation?: 'set' | 'add' | 'contribution';
		amount?: number;
		reason?: string;
	} => ({}));
	if (!body.operation || body.amount === undefined) {
		throw new AppError(422, 'operation and amount are required');
	}
	if (!['set', 'add', 'contribution'].includes(body.operation)) {
		throw new AppError(422, 'operation must be set, add, or contribution');
	}
	if (body.reason !== undefined
		&& (typeof body.reason !== 'string' || body.reason.length > 500)) {
		throw new AppError(422, 'reason must be a string of at most 500 characters');
	}
	const actor = c.get('currentAccount')!;
	const targetAccountId = c.req.param('accountId');
	if (body.operation === 'set') {
		return c.json(await setInvitationCredits(
			actor.id, targetAccountId, body.amount, body.reason,
		));
	}
	if (body.operation === 'add') {
		return c.json(await addInvitationCredits(
			actor.id, targetAccountId, body.amount, body.reason,
		));
	}
	if (!Number.isSafeInteger(body.amount)) {
		throw new AppError(422, 'Contribution amount must be a safe integer');
	}
	await adjustContributionScore({
		targetAccountId,
		actorAccountId: actor.id,
		delta: body.amount,
		reason: body.reason,
		source: 'admin_invitation_credits',
	});
	return c.json(await getInvitationCreditStatus(targetAccountId, 'admin'));
});

export const invitationAuditLogsAdminApi = new Hono<{ Variables: AppVariables }>();

invitationAuditLogsAdminApi.use('*', authRequired, adminOnlyRequired);
invitationAuditLogsAdminApi.use('*', requireScopeForMethod('admin:read', 'admin:write'));

invitationAuditLogsAdminApi.get('/', async (c) => {
	const limit = Math.min(integerQuery(c.req.query('limit'), 50), 100);
	const offset = integerQuery(c.req.query('offset'), 0);
	const page = Math.floor(offset / Math.max(1, limit)) + 1;
	return c.json(await listInvitationAuditLogs(page, limit, {
		action: null,
		accountId: null,
	}, offset));
});
