import { Hono } from 'hono';
import type { AppVariables } from '../../../../../types';
import { AppError } from '../../../../../middleware/errorHandler';
import { sendRejection } from '../../../../../services/email';
import { sanitizeLocale } from '../../../../../utils/locales';
import { getAccountWithUser, rejectAccount } from '../../../../../services/admin';

type HonoEnv = { Variables: AppVariables };

const app = new Hono<HonoEnv>();

/**
 * POST /api/v1/admin/accounts/:id/reject — reject and delete a pending account.
 */
app.post('/:id/reject', async (c) => {
	const id = c.req.param('id');

	const { account, user } = await getAccountWithUser(id);

	if (user.approved) throw new AppError(403, 'This account is not pending approval');

	// Send rejection email in user's locale before deleting (best-effort — never block rejection)
	if (user.email) {
		try {
			await sendRejection(user.email as string, sanitizeLocale(user.locale as string | null));
		} catch { /* email queue failure should not block rejection */ }
	}

	// Delete the user and account (cascading)
	await rejectAccount(id);

	return c.json({}, 200);
});

export default app;
