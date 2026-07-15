import { Hono } from 'hono';
import type { AppVariables } from '../../../../../types';
import { AppError } from '../../../../../middleware/errorHandler';
import { sendRejection } from '../../../../../services/email';
import { sanitizeLocale } from '../../../../../utils/locales';
import { getAccountWithUser } from '../../../../../services/admin';
import { assertAccountModeratable } from '../../../../../services/permissions';
import { deletePendingRegistration } from '../../../../../services/registration';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * POST /api/v1/admin/accounts/:id/reject — reject and delete a pending account.
 */
app.post('/:id/reject', async (c) => {
	const id = c.req.param('id');

	const { account, user } = await getAccountWithUser(id);
	const currentUser = c.get('currentUser')!;
	await assertAccountModeratable(currentUser.role, currentUser.account_id, id);

	if (user.registration_state !== 'pending_approval') {
		throw new AppError(403, 'This account is not pending approval');
	}

	// Atomically delete only while the account is still pending approval. This
	// prevents a concurrent approval from being overwritten by a stale reject.
	await deletePendingRegistration(user.id as string, 'pending_approval', 'rejected');

	// Send the rejection only after deletion succeeds (best-effort).
	if (user.email) {
		try {
			await sendRejection(user.email as string, sanitizeLocale(user.locale as string | null));
		} catch { /* email queue failure should not block rejection */ }
	}

	return c.json({}, 200);
});

export default app;
