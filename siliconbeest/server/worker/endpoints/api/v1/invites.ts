import { Hono } from 'hono';
import type { AppVariables } from '../../../types';
import { AppError } from '../../../middleware/errorHandler';
import { authRequired } from '../../../middleware/auth';
import { requireScopeForMethod } from '../../../middleware/scopeCheck';
import {
	cleanupExpiredInvitedRegistrations,
	createRegistrationInvite,
	listRegistrationInvites,
	revokeRegistrationInvite,
} from '../../../services/registration';
import { getInvitationCreditStatus } from '../../../services/invitationCredits';

const app = new Hono<{ Variables: AppVariables }>();

app.use('*', authRequired);
app.use('*', requireScopeForMethod('read:accounts', 'write:accounts'));

app.get('/', async (c) => {
	const account = c.get('currentAccount')!;
	await cleanupExpiredInvitedRegistrations(account.id);
	return c.json(await listRegistrationInvites(account.id));
});

app.get('/credits', async (c) => {
	const account = c.get('currentAccount')!;
	const user = c.get('currentUser')!;
	await cleanupExpiredInvitedRegistrations(account.id);
	return c.json(await getInvitationCreditStatus(account.id, user.role));
});

app.post('/', async (c) => {
	const body = await c.req.json<{
		uses?: number;
		expires_in_days?: number | null;
		auto_follow?: boolean;
	}>().catch((): {
		uses?: number;
		expires_in_days?: number | null;
		auto_follow?: boolean;
	} => ({}));
	if (body.uses === undefined || body.expires_in_days === undefined || body.auto_follow === undefined) {
		throw new AppError(422, 'uses, expires_in_days, and auto_follow are required');
	}
	if (typeof body.auto_follow !== 'boolean') {
		throw new AppError(422, 'auto_follow must be a boolean');
	}
	const account = c.get('currentAccount')!;
	const user = c.get('currentUser')!;
	await cleanupExpiredInvitedRegistrations(account.id);
	return c.json(await createRegistrationInvite(account.id, user.role, {
		uses: body.uses,
		expiresInDays: body.expires_in_days,
		autoFollow: body.auto_follow,
	}));
});

app.delete('/:id', async (c) => {
	const account = c.get('currentAccount')!;
	await cleanupExpiredInvitedRegistrations(account.id);
	await revokeRegistrationInvite(account.id, c.req.param('id'));
	return c.json({});
});

export default app;
